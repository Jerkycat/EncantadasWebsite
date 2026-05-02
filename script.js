// Estado da aplicação
let currentTab = 'inicio';
let currentEpisode = null;
let episodesList = [];
let isLoadingEpisodes = false;

// Elementos do DOM
const mainElement = document.querySelector('main');
const navLinks = document.querySelectorAll('header section:last-child a');

// Inicializa a aplicação
async function init() {
    setupNavigation();
    await loadEpisodes();
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
    navLinks[1].addEventListener('click', () => switchTab('fanarts'));
    navLinks[2].addEventListener('click', () => switchTab('links'));
}

// Muda de tab
function switchTab(tab) {
    currentTab = tab;
    navLinks.forEach(link => link.classList.remove('active'));
    const activeIndex = tab === 'inicio' ? 0 : tab === 'fanarts' ? 1 : 2;
    navLinks[activeIndex].classList.add('active');
    renderContent();
}

// Renderiza o conteúdo baseado na tab atual
function renderContent() {
    switch (currentTab) {
        case 'inicio':   renderVideoPlayer(); break;
        case 'fanarts':  renderFanarts();     break;
        case 'links':    renderLinks();       break;
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

async function registerView(episode) {
    const key = getEpisodeKey(episode);
    try {
        await fetch(`/api/view/${encodeURIComponent(key)}`, { method: 'POST' });
        // Atualiza a contagem de views no bloco de stats
        await loadEpisodeStats(episode);
    } catch (e) {
        console.error('Erro ao registrar view:', e);
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
            <span class="stat-views">
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

    // Botões de episódio
    document.querySelectorAll('.episode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.currentTarget.dataset.index);
            currentEpisode = index;
            renderVideoPlayer();
        });
    });

    // Carrega o novo vídeo
    const newVideo = document.querySelector('.video-element');
    if (newVideo) {
        newVideo.load();
        // Registra view apenas uma vez por sessão de reprodução
        newVideo.addEventListener('play', () => registerView(selectedEpisode), { once: true });
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
    if (currentEpisode === null || currentEpisode === 0) {
        currentEpisode = episodesList.length - 1;
    } else {
        currentEpisode--;
    }
    renderVideoPlayer();
}

// Navega para o próximo episódio
function handleNextEpisode() {
    if (episodesList.length === 0) return;
    if (currentEpisode === null) {
        currentEpisode = 0;
    } else if (currentEpisode >= episodesList.length - 1) {
        currentEpisode = 0;
    } else {
        currentEpisode++;
    }
    renderVideoPlayer();
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
