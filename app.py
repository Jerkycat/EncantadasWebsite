from flask import Flask, send_from_directory, request, jsonify
import sqlite3, os, math

app = Flask(__name__)

STATIC_DIR = '/var/www/html/EncantadasWebsite'
DB_PATH = '/var/www/html/EncantadasWebsite/interactions.db'


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


def wilson_score(likes, dislikes):
    """Converte likes/dislikes para 0-5 usando Wilson score (95% confiança)."""
    n = likes + dislikes
    if n == 0:
        return 0.0
    z = 1.96
    p = likes / n
    score = (p + z*z/(2*n) - z * math.sqrt((p*(1-p) + z*z/(4*n)) / n)) / (1 + z*z/n)
    return round(score * 5, 2)


# ── API ──────────────────────────────────────────────────────────────────────

@app.route('/api/stats/<episode>')
def get_stats(episode):
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


@app.route('/api/view/<episode>', methods=['POST'])
def register_view(episode):
    with get_db() as conn:
        conn.execute('''
            INSERT INTO interactions (episode, views) VALUES (?, 1)
            ON CONFLICT(episode) DO UPDATE SET views = views + 1
        ''', (episode,))
    return jsonify({'ok': True})


@app.route('/api/vote/<episode>', methods=['POST'])
def register_vote(episode):
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


# ── Rotas estáticas ───────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(STATIC_DIR, path)


if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=8081, debug=False)
