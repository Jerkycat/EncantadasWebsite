// Estado da aplicação
let currentTab = 'inicio';
let currentEpisode = null;
let episodesList = [];
let isLoadingEpisodes = false;

// Socket.IO: o backend grava início/fim na sessão Flask (cookie assinado); o cliente só avisa play/ended.
const socket = typeof io !== 'undefined' ? io({ transports: ['websocket', 'polling'] }) : null;

function emitPlaybackStart(episodeKey) {
    if (!socket) return;
    const run = () => socket.emit('playback_start', { episode: episodeKey });
    if (socket.connected) run();
    else socket.once('connect', run);
}

function emitPlaybackComplete(episodeKey) {
    if (!socket) return;
    const run = () => socket.emit('playback_complete', { episode: episodeKey });
    if (socket.connected) run();
    else socket.once('connect', run);
}

// ── View após 10s assistidos (sem contar seek) ────────────────────────────────
function attachViewAfterTenSeconds(videoEl, episodeKey) {
    if (!videoEl) return;

    let started = false;
    let viewSent = false;
    let watchedSeconds = 0;
    let lastVideoTime = null;

    const maybeStart = () => {
        if (started) return;
        started = true;
        emitPlaybackStart(episodeKey);
        lastVideoTime = videoEl.currentTime;
    };

    const onTimeUpdate = () => {
        if (viewSent) return;
        if (videoEl.paused || videoEl.seeking) return;

        if (!started) maybeStart();

        const t = videoEl.currentTime;
        if (lastVideoTime == null) {
            lastVideoTime = t;
            return;
        }

        const delta = t - lastVideoTime;
        lastVideoTime = t;

        // Ignora jumps grandes (seek) e deltas negativos.
        if (delta <= 0 || delta > 1.5) return;

        watchedSeconds += delta;
        if (watchedSeconds >= 10) {
            viewSent = true;
            emitPlaybackComplete(episodeKey);
        }
    };

    const onSeeking = () => {
        lastVideoTime = videoEl.currentTime;
    };

    // Se o usuário apertar play e ficar um tempo sem timeupdate (raro), ainda marcamos start.
    videoEl.addEventListener('play', maybeStart);
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('seeking', onSeeking);
}

function updateViewsInDom(episodeKey, views) {
    const esc = episodeKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const statEl = document.querySelector(`#stats-container .stat-views[data-episode-key="${esc}"]`);
    if (statEl) {
        statEl.innerHTML = `
                <span class="material-symbols-outlined">visibility</span>
                ${views} view${views !== 1 ? 's' : ''}
            `;
    }
    const rankEl = document.querySelector(`.rankings-table .views-col[data-episode-key="${esc}"]`);
    if (rankEl) {
        rankEl.innerHTML = `${views} <small>view${views !== 1 ? 's' : ''}</small>`;
    }
}

if (socket) {
    socket.on('view_count_updated', ({ episode, views }) => {
        if (episode != null && views != null) updateViewsInDom(episode, views);
    });

    socket.on('view_accepted', ({ episode, views }) => {
        if (episode != null && views != null) updateViewsInDom(episode, views);
    });
}

// Elementos do DOM
const mainElement = document.querySelector('main');
const navLinks = document.querySelectorAll('header section:last-child a');

// ── Roteamento via History API ────────────────────────────────────────────────

/**
 * Interpreta o pathname atual e retorna um objeto com tab e informações do episódio.
 */
function parseUrlState() {
    const path = window.location.pathname;

    // Tabs simples
    const tabMatch = path.match(/^\/(rankings|fanarts|links)\/?$/);
    if (tabMatch) return { tab: tabMatch[1] };

    // /promo
    if (/^\/promo\/?$/i.test(path)) return { tab: 'inicio', episodeType: 'promo' };

    // /ep10 ou /ep0
    const epMatch = path.match(/^\/ep(\d+)\/?$/i);
    if (epMatch) return { tab: 'inicio', episodeNumber: parseInt(epMatch[1]) };

    // / ou qualquer outra coisa → início
    return { tab: 'inicio', episodeIndex: null };
}

/**
 * Depois de carregar os episódios, resolve o índice correto a partir do estado da URL.
 */
function resolveEpisodeIndex(urlState) {
    if (!urlState || urlState.tab !== 'inicio') return null;

    if (urlState.episodeNumber !== undefined) {
        const idx = episodesList.findIndex(ep => ep.number === urlState.episodeNumber);
        return idx !== -1 ? idx : null;
    }
    if (urlState.episodeType === 'promo') {
        const idx = episodesList.findIndex(ep => ep.type === 'promo');
        return idx !== -1 ? idx : null;
    }
    if (urlState.episodeIndex !== undefined) return urlState.episodeIndex;

    return null; // padrão → exibe o promo
}

/**
 * Monta a URL correta para o estado (tab + índice de episódio).
 */
function buildUrl(tab, episodeIndex) {
    if (tab !== 'inicio') return `/${tab}`;
    if (episodeIndex === null || episodeIndex === undefined) return '/';

    const ep = episodesList[episodeIndex];
    if (!ep) return '/';
    if (ep.type === 'promo') return '/promo';
    // Usa !== null para cobrir ep0 (zero é falsy em JS, mas é um número válido)
    if (ep.number !== null && ep.number !== undefined) return `/ep${ep.number}`;
    return '/';
}

/**
 * Atualiza a classe .active dos links de navegação.
 */
function updateNavActive() {
    navLinks.forEach(link => link.classList.remove('active'));
    const idx = { inicio: 0, rankings: 1, fanarts: 2, links: 3 }[currentTab];
    if (idx !== undefined) navLinks[idx].classList.add('active');
}

/**
 * Navega para um episódio específico dentro de /inicio, atualiza a URL e re-renderiza.
 */
function navigateToEpisode(index) {
    currentEpisode = index;
    const url = buildUrl('inicio', index);
    history.pushState({ tab: 'inicio', episode: index }, '', url);
    renderVideoPlayer();
}

// Captura navegação pelo botão Voltar/Avançar do browser
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.tab) {
        currentTab = e.state.tab;
        currentEpisode = (e.state.episode !== undefined && e.state.episode !== null)
            ? e.state.episode
            : null;
    } else {
        // Sem state guardado: relê a URL (ex.: entrada direta no histórico)
        const urlState = parseUrlState();
        currentTab = urlState.tab || 'inicio';
        currentEpisode = resolveEpisodeIndex(urlState);
    }
    updateNavActive();
    renderContent();
});

// Inicializa a aplicação
async function init() {
    const urlState = parseUrlState();
    currentTab = urlState.tab || 'inicio';

    // Mostra a aba certa imediatamente (antes de carregar episódios)
    updateNavActive();
    setupNavigation();

    await loadEpisodes();

    // Resolve índice do episódio agora que a lista está carregada
    if (currentTab === 'inicio') {
        currentEpisode = resolveEpisodeIndex(urlState);
    }

    // Normaliza URL: grava estado inicial e redireciona legado /inicio -> /
    const rawPath = window.location.pathname;
    const canonicalUrl = /^\/inicio\/?$/i.test(rawPath) ? '/' : rawPath;
    history.replaceState({ tab: currentTab, episode: currentEpisode }, '', canonicalUrl);

    renderContent();
}

// Carrega a lista de episódios
async function loadEpisodes() {
    if (isLoadingEpisodes) return;
    isLoadingEpisodes = true;

    try {
        const response = await fetch('/static/videos/list.json');
        const fileNames = await response.json();

        episodesList = fileNames
            .map(fileName => {
                const fullFileName = fileName.toLowerCase().endsWith('.mp4') ? fileName : fileName + '.mp4';
                const nameWithoutExt = fullFileName.replace('.mp4', '');

                if (nameWithoutExt.toLowerCase().includes('promo')) {
                    return {
                        type: 'promo',
                        number: null,
                        title: 'Vídeo Promocional',
                        fileName: fullFileName
                    };
                }

                const match = nameWithoutExt.match(/ep(\d+)\s*-\s*(.+)/i);
                if (match) {
                    return {
                        type: 'episode',
                        number: parseInt(match[1]),
                        title: match[2].trim(),
                        fileName: fullFileName
                    };
                }

                return {
                    type: 'episode',
                    number: null,
                    title: nameWithoutExt,
                    fileName: fullFileName
                };
            })
            .sort((a, b) => {
                if (a.type === 'promo') return -1;
                if (b.type === 'promo') return 1;
                return (a.number || 0) - (b.number || 0);
            });

        console.log('Episódios carregados:', episodesList);
    } catch (error) {
        console.error('Erro ao carregar lista de episódios:', error);
        episodesList = [{
            type: 'promo',
            number: null,
            title: 'Vídeo Promocional',
            fileName: 'videopromo.mp4'
        }];
    }

    isLoadingEpisodes = false;
}

// Configura os eventos de navegação
function setupNavigation() {
    navLinks[0].addEventListener('click', () => switchTab('inicio'));
    navLinks[1].addEventListener('click', () => switchTab('rankings'));
    navLinks[2].addEventListener('click', () => switchTab('fanarts'));
    navLinks[3].addEventListener('click', () => switchTab('links'));
}

// Muda de tab e atualiza a URL
function switchTab(tab) {
    currentTab = tab;
    updateNavActive();

    // Ao voltar para /inicio, mantém o episódio que estava selecionado
    const url = buildUrl(tab, tab === 'inicio' ? currentEpisode : null);
    history.pushState({ tab, episode: currentEpisode }, '', url);

    renderContent();
}

// Renderiza o conteúdo baseado na tab atual
function renderContent() {
    switch (currentTab) {
        case 'inicio':    renderVideoPlayer(); break;
        case 'rankings':  renderRankings();    break;
        case 'fanarts':   renderFanarts();     break;
        case 'links':     renderLinks();       break;
    }
}

// ── Stats / Interações ────────────────────────────────────────────────────────

function getEpisodeKey(episode) {
    return episode.fileName.replace('.mp4', '');
}

async function loadEpisodeStats(episode) {
    const key = getEpisodeKey(episode);
    try {
        const res = await fetch(`/api/stats/${encodeURIComponent(key)}`);
        const data = await res.json();
        renderStats(data, key);
    } catch (e) {
        console.error('Erro ao carregar stats:', e);
    }
}

function starsDisplay(score) {
    const full  = Math.floor(score);
    const half  = (score - full) >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    return (
        '<span class="material-symbols-outlined star filled">star</span>'.repeat(full) +
        (half ? '<span class="material-symbols-outlined star half">star_half</span>' : '') +
        '<span class="material-symbols-outlined star empty">star</span>'.repeat(empty)
    );
}

function renderStats(data, episodeKey) {
    const container = document.getElementById('stats-container');
    if (!container) return;

    const userVote = localStorage.getItem(`vote_${episodeKey}`);
    const stars    = starsDisplay(data.stars);
    const total    = data.likes + data.dislikes;

    container.innerHTML = `
        <div class="stats-block">
            <span class="stat-views" data-episode-key="${episodeKey}">
                <span class="material-symbols-outlined">visibility</span>
                ${data.views} view${data.views !== 1 ? 's' : ''}
            </span>

            <span class="stat-stars" title="${data.stars}/5 baseado em ${total} voto${total !== 1 ? 's' : ''}">
                ${stars}
                <small>${data.stars}/5</small>
            </span>

            <div class="vote-buttons">
                <button class="vote-btn like-btn ${userVote === 'like' ? 'voted' : ''}"
                        onclick="vote('${episodeKey}', 'like')"
                        ${userVote ? 'disabled' : ''}
                        title="Curtir">
                    <span class="material-symbols-outlined">thumb_up</span>
                    ${data.likes}
                </button>
                <button class="vote-btn dislike-btn ${userVote === 'dislike' ? 'voted' : ''}"
                        onclick="vote('${episodeKey}', 'dislike')"
                        ${userVote ? 'disabled' : ''}
                        title="Não curtir">
                    <span class="material-symbols-outlined">thumb_down</span>
                    ${data.dislikes}
                </button>
            </div>
        </div>
    `;
}

async function vote(episodeKey, voteType) {
    if (localStorage.getItem(`vote_${episodeKey}`)) return;

    try {
        const res = await fetch(`/api/vote/${encodeURIComponent(episodeKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vote: voteType })
        });
        const data = await res.json();
        localStorage.setItem(`vote_${episodeKey}`, voteType);
        renderStats(data, episodeKey);
    } catch (e) {
        console.error('Erro ao votar:', e);
    }
}

// ── Rankings ──────────────────────────────────────────────────────────────────

async function renderRankings() {
    mainElement.innerHTML = `
        <div class="rankings-container">
            <h2 class="section-title">RANKINGS</h2>
            <div class="loading-message">Carregando rankings...</div>
        </div>
    `;

    const episodes = episodesList.filter(ep => ep.type !== 'promo');

    if (episodes.length === 0) {
        document.querySelector('.loading-message').textContent = 'Nenhum episódio encontrado.';
        return;
    }

    try {
        // Busca stats de todos os episódios em paralelo
        const statsPromises = episodes.map(async ep => {
            const key = getEpisodeKey(ep);
            try {
                const res = await fetch(`/api/stats/${encodeURIComponent(key)}`);
                const data = await res.json();
                return { ...ep, stats: data };
            } catch {
                return { ...ep, stats: { views: 0, likes: 0, dislikes: 0, stars: 0 } };
            }
        });

        const results = await Promise.all(statsPromises);

        // Ordena por estrelas (desc), com views como desempate
        results.sort((a, b) => {
            if (b.stats.stars !== a.stats.stars) return b.stats.stars - a.stats.stars;
            return b.stats.views - a.stats.views;
        });

        const container = document.querySelector('.rankings-container');
        const loadingMsg = container.querySelector('.loading-message');
        loadingMsg.remove();

        const table = document.createElement('div');
        table.className = 'rankings-table';

        table.innerHTML = `
            <div class="rankings-header">
                <span class="rank-col">#</span>
                <span class="title-col">Episódio</span>
                <span class="views-col">
                    <span class="material-symbols-outlined">visibility</span>
                </span>
                <span class="stars-col">Avaliação</span>
            </div>
            ${results.map((ep, i) => {
                const stars = starsDisplay(ep.stats.stars);
                const medal = i === 0 ? 'emoji_events' : i === 1 ? 'workspace_premium' : i === 2 ? 'military_tech' : null;
                const rankDisplay = medal
                    ? `<span class="material-symbols-outlined medal rank-${i + 1}">${medal}</span>`
                    : `<span class="rank-number">${i + 1}</span>`;

                return `
                    <div class="rankings-row ${i < 3 ? 'top-' + (i + 1) : ''}"
                         onclick="goToEpisode('${ep.fileName}')">
                        <span class="rank-col">${rankDisplay}</span>
                        <span class="title-col">
                            <span class="ep-label">EP ${ep.number}</span>
                            <span class="ep-name">${ep.title}</span>
                        </span>
                        <span class="views-col" data-episode-key="${getEpisodeKey(ep)}">
                            ${ep.stats.views} <small>view${ep.stats.views !== 1 ? 's' : ''}</small>
                        </span>
                        <span class="stars-col">
                            <span class="stars-row">${stars}</span>
                            <small>${ep.stats.stars}/5</small>
                        </span>
                    </div>
                `;
            }).join('')}
        `;

        container.appendChild(table);

    } catch (error) {
        console.error('Erro ao carregar rankings:', error);
        document.querySelector('.loading-message').textContent = 'Erro ao carregar rankings.';
    }
}

// Vai para um episódio específico a partir do ranking
function goToEpisode(fileName) {
    const index = episodesList.findIndex(ep => ep.fileName === fileName);
    if (index !== -1) {
        currentEpisode = index;
        switchTab('inicio');
    }
}

// ── Player de vídeo ───────────────────────────────────────────────────────────

function renderVideoPlayer() {
    if (episodesList.length === 0) {
        mainElement.innerHTML = `<div class="loading-message">Carregando episódios...</div>`;
        return;
    }

    let selectedEpisode;
    if (currentEpisode === null) {
        selectedEpisode = episodesList.find(ep => ep.type === 'promo') || episodesList[0];
    } else {
        selectedEpisode = episodesList[currentEpisode];
    }

    const videoSource  = `/static/videos/${selectedEpisode.fileName}`;
    const episodeTitle = selectedEpisode.title;

    const oldVideo = document.querySelector('.video-element');
    if (oldVideo) {
        oldVideo.pause();
        oldVideo.removeAttribute('src');
        oldVideo.load();
    }

    mainElement.innerHTML = `
        <div class="video-container">
            <div class="video-wrapper">
                <button class="nav-arrow left" id="prevBtn">
                    <span class="material-symbols-outlined">chevron_left</span>
                </button>

                <div class="video-player">
                    <video controls class="video-element" preload="metadata">
                        <source src="${videoSource}" type="video/mp4">
                        Seu navegador não suporta o elemento de vídeo.
                    </video>
                </div>

                <button class="nav-arrow right" id="nextBtn">
                    <span class="material-symbols-outlined">chevron_right</span>
                </button>
            </div>

            <div class="episode-title">
                <h2>${episodeTitle}</h2>
            </div>

            <div id="stats-container"></div>

            <div class="episode-selector">
                <div class="selector-label">Selecione o Episódio:</div>
                <div class="episode-grid" id="episodeGrid">
                    ${generateEpisodeButtons()}
                </div>
            </div>
        </div>
    `;

    // Navegação
    document.getElementById('prevBtn').addEventListener('click', handlePrevEpisode);
    document.getElementById('nextBtn').addEventListener('click', handleNextEpisode);

    // Botões de episódio — usam navigateToEpisode para atualizar a URL
    document.querySelectorAll('.episode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            navigateToEpisode(parseInt(e.currentTarget.dataset.index));
        });
    });

    // Carrega o novo vídeo
    const newVideo = document.querySelector('.video-element');
    if (newVideo) {
        newVideo.load();
        const epKey = getEpisodeKey(selectedEpisode);
        attachViewAfterTenSeconds(newVideo, epKey);
    }

    // Carrega stats imediatamente
    loadEpisodeStats(selectedEpisode);
}

// Gera os botões de episódios
function generateEpisodeButtons() {
    return episodesList.map((episode, index) => {
        const isActive = currentEpisode === index || (currentEpisode === null && episode.type === 'promo');
        const label    = episode.type === 'promo' ? 'PROMO' : `EP ${episode.number}`;
        const starIcon = [6, 11, 14].includes(episode.number)
            ? ' <span class="material-symbols-outlined">star</span>' : '';

        return `
            <button class="episode-btn ${isActive ? 'active' : ''}"
                    data-index="${index}"
                    title="${episode.title}">
                ${label}${starIcon}
            </button>
        `;
    }).join('');
}

// Navega para o episódio anterior
function handlePrevEpisode() {
    if (episodesList.length === 0) return;
    let newIndex;
    if (currentEpisode === null || currentEpisode === 0) {
        newIndex = episodesList.length - 1;
    } else {
        newIndex = currentEpisode - 1;
    }
    navigateToEpisode(newIndex);
}

// Navega para o próximo episódio
function handleNextEpisode() {
    if (episodesList.length === 0) return;
    let newIndex;
    if (currentEpisode === null) {
        newIndex = 0;
    } else if (currentEpisode >= episodesList.length - 1) {
        newIndex = 0;
    } else {
        newIndex = currentEpisode + 1;
    }
    navigateToEpisode(newIndex);
}

// ── Fanarts ───────────────────────────────────────────────────────────────────

async function renderFanarts() {
    mainElement.innerHTML = `
        <div class="fanarts-container">
            <h2 class="section-title">FANARTS</h2>
            <div class="loading-message">Carregando fanarts...</div>
            <div class="media-wrapper"></div>
        </div>
    `;

    try {
        const response  = await fetch('/static/imgs/fanarts/list.json');
        const fileNames = await response.json();

        const mediaWrapper   = document.querySelector('.media-wrapper');
        const loadingMessage = document.querySelector('.loading-message');

        if (fileNames.length === 0) {
            loadingMessage.textContent = 'Nenhuma fanart encontrada.';
            return;
        }

        loadingMessage.remove();

        fileNames.forEach(fileName => {
            const imagePath = `/static/imgs/fanarts/${fileName}`;
            const fanartItem = document.createElement('div');
            fanartItem.className = 'fanart-item';
            fanartItem.innerHTML = `
                <img src="${imagePath}" alt="${fileName}" title="${fileName}" loading="lazy">
            `;
            mediaWrapper.appendChild(fanartItem);
        });

    } catch (error) {
        console.error('Erro ao carregar fanarts:', error);
        document.querySelector('.loading-message').textContent =
            'Erro ao carregar fanarts. Verifique se o arquivo list.json existe.';
    }
}

// ── Links ─────────────────────────────────────────────────────────────────────

function renderLinks() {
    mainElement.innerHTML = `
        <div class="links-container">
            <h2 class="section-title">LINKS</h2>
            <div class="links-content">
                <a target="_blank" href="https://apoia.se/miamidesantos">
                    <img src="static/imgs/decorations/apoiase.png" alt="">
                </a>
                <a target="_blank" href="https://www.bitchute.com/channel/qTng5tXglxlo">
                    <img src="static/imgs/decorations/bitchute.png" alt="">
                </a>
                <a target="_blank" href="https://odysee.com/@MiamiDeSantos:5">
                    <img src="static/imgs/decorations/odysee.png" alt="">
                </a>
                <a target="_blank" href="https://t.me/miamidesantosoficial">
                    <img src="static/imgs/decorations/telegram.png" alt="">
                </a>
                <a target="_blank" href="https://discord.com/invite/Xh2ZpFqyrx">
                    <img src="static/imgs/decorations/discord.png" alt="">
                </a>
                <a target="_blank" href="https://kick.com/miamidesantos">
                    <img src="static/imgs/decorations/kick.png" alt="">
                </a>
                <a target="_blank" href="https://x.com/miamidesantos">
                    <img src="static/imgs/decorations/twitterx.png" alt="">
                </a>
                <a target="_blank" href="https://www.instagram.com/miamidesantos/">
                    <img src="static/imgs/decorations/isntragram.png" alt="">
                </a>
                <a target="_blank" href="https://www.facebook.com/miamidesantos/">
                    <img src="static/imgs/decorations/facebook.png" alt="">
                </a>
            </div>
        </div>
    `;
}

// ── Init ──────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
