from flask import Flask, send_from_directory, request, jsonify, session
from flask_socketio import SocketIO, emit, disconnect
import sqlite3
import os
import re
import math
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.environ.get('ENCANTADAS_STATIC', BASE_DIR)
DB_PATH = os.environ.get('ENCANTADAS_DB', os.path.join(BASE_DIR, 'interactions.db'))

app = Flask(__name__)
# Sessão em cookie assinado (itsdangerous): playback guarda started_at / ended_at no servidor.
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'troque-esta-chave-em-producao')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
if os.environ.get('SESSION_COOKIE_SECURE', '').lower() in ('1', 'true', 'yes'):
    app.config['SESSION_COOKIE_SECURE'] = True

socketio = SocketIO(app, async_mode='threading')

_EPISODE_KEY_RE = re.compile(r'^[\w\s.()\-\u00C0-\u024F]{1,200}$', re.UNICODE)

# Sessão Flask = cookie assinado (itsdangerous). Só usamos started_at / ended_at do servidor.
# Conta view só após ~30*s (gatilho vem do cliente ao atingir 30*s assistidos).
_MIN_ELAPSED_SECONDS = 25
_MAX_ELAPSED_SECONDS = 6 * 3600

# Controle de views por conexão Socket.IO (server-side, sem depender de cookie)
_counted_by_sid = {}   # { sid: set(episode_keys) }
_playback_by_sid = {}  # { sid: { episode: { started_at: float } } }


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS interactions (
                episode  TEXT PRIMARY KEY,
                views    INTEGER DEFAULT 0,
                likes    INTEGER DEFAULT 0,
                dislikes INTEGER DEFAULT 0
            )
        ''')


def ensure_database():
    """Garante pasta do ficheiro SQLite e cria a DB/tabela se ainda não existirem."""
    parent = os.path.dirname(os.path.abspath(DB_PATH))
    if parent:
        os.makedirs(parent, exist_ok=True)
    init_db()


ensure_database()


def wilson_score(likes, dislikes):
    """Converte likes/dislikes para 0-5 usando Wilson score (80% confiança)."""
    n = likes + dislikes
    if n == 0:
        return 0.0
    z = 1.28
    p = likes / n
    score = (p + z * z / (2 * n) - z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n)
    return round(score * 5, 2)


def valid_episode_key(episode):
    return bool(episode and _EPISODE_KEY_RE.match(episode))


def _session_playback():
    return _playback_by_sid.get(request.sid, {})

def _session_counted():
    return _counted_by_sid.get(request.sid, set())

def _mark_counted(episode):
    _counted_by_sid.setdefault(request.sid, set()).add(episode)

def _set_playback(episode, data):
    _playback_by_sid.setdefault(request.sid, {})[episode] = data

def _clear_playback(episode):
    _playback_by_sid.get(request.sid, {}).pop(episode, None)


def _broadcast_views(episode, views):
    socketio.emit('view_count_updated', {'episode': episode, 'views': views})


def increment_view_and_broadcast(episode):
    with get_db() as conn:
        conn.execute('''
            INSERT INTO interactions (episode, views) VALUES (?, 1)
            ON CONFLICT(episode) DO UPDATE SET views = views + 1
        ''', (episode,))
        row = conn.execute(
            'SELECT views FROM interactions WHERE episode = ?', (episode,)
        ).fetchone()
        views = int(row['views']) if row else 1
    _broadcast_views(episode, views)
    return views


# ── API ──────────────────────────────────────────────────────────────────────


@app.route('/api/stats/<episode>')
def get_stats(episode):
    if not valid_episode_key(episode):
        return jsonify({'error': 'Invalid episode'}), 400
    with get_db() as conn:
        row = conn.execute(
            'SELECT * FROM interactions WHERE episode = ?', (episode,)
        ).fetchone()
    if row:
        data = dict(row)
    else:
        data = {'episode': episode, 'views': 0, 'likes': 0, 'dislikes': 0}
    data['stars'] = wilson_score(data['likes'], data['dislikes'])
    return jsonify(data)


@app.route('/api/vote/<episode>', methods=['POST'])
def register_vote(episode):
    if not valid_episode_key(episode):
        return jsonify({'error': 'Invalid episode'}), 400
    data = request.get_json()
    vote = data.get('vote')
    if vote not in ('like', 'dislike'):
        return jsonify({'error': 'Invalid vote'}), 400

    col = 'likes' if vote == 'like' else 'dislikes'
    with get_db() as conn:
        conn.execute(f'''
            INSERT INTO interactions (episode, {col}) VALUES (?, 1)
            ON CONFLICT(episode) DO UPDATE SET {col} = {col} + 1
        ''', (episode,))
        row = conn.execute(
            'SELECT * FROM interactions WHERE episode = ?', (episode,)
        ).fetchone()
        d = dict(row)

    d['stars'] = wilson_score(d['likes'], d['dislikes'])
    return jsonify(d)


# ── Socket.IO (playback → view só no fim; tempos só na sessão assinada) ──────

@socketio.on('disconnect')
def on_disconnect():
    """Libera memória ao desconectar."""
    _counted_by_sid.pop(request.sid, None)
    _playback_by_sid.pop(request.sid, None)


@socketio.on('playback_start')
def on_playback_start(data):
    if not isinstance(data, dict):
        return
    episode = data.get('episode')
    if not valid_episode_key(episode):
        emit('playback_error', {'code': 'invalid_episode'})
        return
    _set_playback(episode, {'started_at': time.time()})


@socketio.on('playback_complete')
def on_playback_complete(data):
    if not isinstance(data, dict):
        return
    episode = data.get('episode')
    if not valid_episode_key(episode):
        emit('view_rejected', {'episode': episode, 'code': 'invalid_episode'})
        return

    counted = _session_counted()
    if episode in counted:
        emit('view_rejected', {'episode': episode, 'code': 'already_counted'})
        return

    pb = _session_playback()
    info = pb.get(episode, {})
    if 'started_at' not in info:
        emit('view_rejected', {'episode': episode, 'code': 'no_start'})
        return

    try:
        started_at = float(info['started_at'])
    except (TypeError, ValueError):
        emit('view_rejected', {'episode': episode, 'code': 'no_start'})
        return

    elapsed = time.time() - started_at
    if elapsed < _MIN_ELAPSED_SECONDS:
        emit('view_rejected', {'episode': episode, 'code': 'too_short'})
        return

    if elapsed > _MAX_ELAPSED_SECONDS:
        _clear_playback(episode)
        emit('view_rejected', {'episode': episode, 'code': 'session_expired'})
        return

    _mark_counted(episode)
    _clear_playback(episode)

    views = increment_view_and_broadcast(episode)
    emit('view_accepted', {'episode': episode, 'views': views})


# ── Rotas estáticas e SPA ─────────────────────────────────────────────────────

# Rotas SPA conhecidas — todas devolvem index.html para o JS tratar
_SPA_ROUTES = re.compile(
    r'^/(promo|ep\d+|rankings|fanarts|links)/?$',
    re.IGNORECASE
)


@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    # 1. Tenta servir como ficheiro estático real (css, js, imagens, etc.)
    file_path = os.path.join(STATIC_DIR, path)
    if os.path.isfile(file_path):
        return send_from_directory(STATIC_DIR, path)

    # 2. Rota SPA reconhecida → devolve index.html (o JS cuida do roteamento)
    if _SPA_ROUTES.match('/' + path):
        return send_from_directory(STATIC_DIR, 'index.html')

    # 3. Fallback genérico: qualquer path desconhecido também devolve index.html
    #    (evita 404 em deep links inesperados)
    return send_from_directory(STATIC_DIR, 'index.html')


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8081, debug=False, allow_unsafe_werkzeug=True)
