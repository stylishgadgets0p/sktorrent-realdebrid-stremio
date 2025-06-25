// SKTorrent Real-Debrid Only Addon pro Stremio
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs").promises;
const path = require("path");

// Real-Debrid API integrace
const RealDebridAPI = require('./realdebrid');

// Cesta ke konfiguračnímu souboru
const CONFIG_FILE = process.env.NODE_ENV === 'production' 
    ? '/tmp/config.json'  // Render.com má pouze /tmp jako writable
    : path.join(__dirname, 'config.json');

// Načtení konfigurace
let config = {
    SKT_UID: process.env.SKT_UID || "",
    SKT_PASS: process.env.SKT_PASS || "",
    REALDEBRID_API_KEY: process.env.REALDEBRID_API_KEY || ""
};

// Funkce pro načtení konfigurace
async function loadConfig() {
    try {
        // Nejdřív zkusit environment variables (pro Render.com)
        if (process.env.REALDEBRID_API_KEY || process.env.SKT_UID) {
            config = {
                SKT_UID: process.env.SKT_UID || "",
                SKT_PASS: process.env.SKT_PASS || "",
                REALDEBRID_API_KEY: process.env.REALDEBRID_API_KEY || ""
            };
            console.log('✅ Konfigurace načtena z environment variables');
            return;
        }
        
        // Pak zkusit soubor
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        config = JSON.parse(data);
        console.log('✅ Konfigurace načtena ze souboru');
    } catch (error) {
        console.log('⚠️ Konfigurace nenalezena, používám výchozí hodnoty');
        console.log('💡 Nastavte konfiguraci přes webové rozhraní nebo environment variables');
    }
}

// Funkce pro uložení konfigurace
async function saveConfig(newConfig) {
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        config = newConfig;
        console.log('✅ Konfigurace uložena');
    } catch (error) {
        console.error('❌ Chyba při ukládání konfigurace:', error);
        throw error;
    }
}

// Inicializace
let rd = null;

async function initializeRD() {
    if (config.REALDEBRID_API_KEY) {
        rd = new RealDebridAPI(config.REALDEBRID_API_KEY);
        console.log('🔧 Real-Debrid aktivován');
    } else {
        console.log('⚠️ Real-Debrid API klíč není nastaven');
    }
}

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent.realdebrid",
    version: "3.0.0",
    name: "SKTorrent RD Only",
    description: "SKTorrent addon pouze s Real-Debrid podporou",
    logo: 'https://i.ibb.co/y5TQrrs/sktorrent.png',
    types: ["movie", "series"],
    catalogs: [],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

// Pomocné funkce
function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function extractQuality(title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('2160p') || titleLower.includes('4k')) return '4K';
    if (titleLower.includes('1080p')) return '1080p';
    if (titleLower.includes('720p')) return '720p';
    if (titleLower.includes('480p')) return '480p';
    return 'SD';
}

// Funkce pro získání názvu z IMDb
async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 5000
        });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            try {
                const json = JSON.parse(ldJson);
                if (json && json.name) originalTitle = decode(json.name.trim());
            } catch (e) {}
        }
        console.log(`[DEBUG] 🌍 Lokalizovaný název: ${title}`);
        console.log(`[DEBUG] 🎬 Originální název: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] Chyba při získávání z IMDb:", err.message);
        return null;
    }
}

// Funkce pro vyhledávání torrentů na SKTorrent
async function searchTorrents(query) {
    if (!config.SKT_UID || !config.SKT_PASS) {
        console.log('[ERROR] SKTorrent přihlašovací údaje nejsou nastaveny');
        return [];
    }

    console.log(`[INFO] 🔎 Hledám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
            headers: { Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}` },
            timeout: 10000
        });
        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const posters = $('a[href^="details.php"] img');
        const results = [];

        posters.each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";
            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;
            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });
        console.log(`[INFO] 📦 Nalezeno torrentů: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhledávání selhalo:", err.message);
        return [];
    }
}

// Funkce pro získání torrent info
async function getTorrentInfo(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}`,
                Referer: BASE_URL
            },
            timeout: 15000
        });
        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");

        return {
            infoHash,
            name: torrent.info.name ? torrent.info.name.toString() : ''
        };
    } catch (err) {
        console.error("[ERROR] Chyba při zpracování .torrent:", err.message);
        return null;
    }
}

// Globální proměnné
let addonBaseUrl = 'http://localhost:7000';

// Cache pro RD
const activeProcessing = new Map();
const rdCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minut

// Stream handler
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n====== 🎮 Požadavek: type='${type}', id='${id}' ======`);

    // Kontrola konfigurace
    if (!config.REALDEBRID_API_KEY) {
        return { 
            streams: [{
                name: "⚠️ Konfigurace chybí",
                title: "Nastavte Real-Debrid API klíč na " + addonBaseUrl,
                url: "#"
            }]
        };
    }

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) return { streams: [] };

    const { title, originalTitle } = titles;
    const queries = new Set();
    const baseTitles = [title, originalTitle].map(t => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim());

    baseTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === 'series' && season && episode) {
            const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            [base, noDia, short].forEach(b => {
                queries.add(b + epTag);
                queries.add((b + epTag).replace(/[\':]/g, ''));
                queries.add((b + epTag).replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        } else {
            [base, noDia, short].forEach(b => {
                queries.add(b);
                queries.add(b.replace(/[\':]/g, ''));
                queries.add(b.replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        }
    });

    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hledám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    if (torrents.length === 0) {
        console.log(`[INFO] ❌ Žádné torrenty nenalezeny`);
        return { streams: [] };
    }

    const streams = [];

    // Zpracování torrentů pouze pro Real-Debrid
    for (const torrent of torrents.slice(0, 10)) {
        const torrentInfo = await getTorrentInfo(torrent.downloadUrl);
        if (!torrentInfo) continue;

        // Parser pro názvy
        let cleanedTitle = torrent.name.replace(/^Stiahni si\s*/i, "").trim();
        const categoryPrefix = torrent.category.trim().toLowerCase();
        if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
            cleanedTitle = cleanedTitle.slice(torrent.category.length).trim();
        }

        const langMatches = torrent.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        const quality = extractQuality(torrent.name);
        
        streams.push({
            name: `⚡ Real-Debrid\n${torrent.category}`,
            title: `${cleanedTitle}\n📊 ${quality}  👤 ${torrent.seeds}  📀 ${torrent.size}${flagsText}`,
            url: `${addonBaseUrl}/process/${torrentInfo.infoHash}`,
            behaviorHints: { bingeGroup: `rd-${cleanedTitle}` }
        });
    }

    console.log(`[INFO] ✅ Odesílám ${streams.length} streamů`);
    return { streams };
});

// Express server
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware pro CORS
app.use((req, res, next) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    });
    next();
});

// Middleware pro nastavení base URL
app.use((req, res, next) => {
    if (req.get('host') && req.get('x-forwarded-proto')) {
        addonBaseUrl = `${req.get('x-forwarded-proto')}://${req.get('host')}`;
    } else if (req.get('host')) {
        addonBaseUrl = `${req.protocol}://${req.get('host')}`;
    }
    next();
});

// Úvodní stránka s konfigurací
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>SKTorrent Real-Debrid Addon</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                    max-width: 900px;
                    margin: 0 auto;
                    padding: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #333;
                    min-height: 100vh;
                }
                .container {
                    background: white;
                    border-radius: 15px;
                    padding: 40px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                }
                h1 {
                    color: #4a5568;
                    text-align: center;
                    margin-bottom: 10px;
                    font-size: 2.5em;
                }
                .subtitle {
                    text-align: center;
                    color: #718096;
                    font-size: 1.2em;
                    margin-bottom: 40px;
                }
                .status-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                    margin: 30px 0;
                }
                .status-card {
                    background: #f7fafc;
                    border-radius: 10px;
                    padding: 20px;
                    text-align: center;
                    border: 2px solid #e2e8f0;
                }
                .status-active { border-color: #48bb78; background: #f0fff4; }
                .status-inactive { border-color: #f56565; background: #fffaf0; }
                .form-group {
                    margin-bottom: 20px;
                }
                label {
                    display: block;
                    font-weight: bold;
                    margin-bottom: 5px;
                    color: #4a5568;
                }
                input[type="text"], input[type="password"] {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 16px;
                    transition: border-color 0.2s;
                }
                input[type="text"]:focus, input[type="password"]:focus {
                    outline: none;
                    border-color: #667eea;
                }
                .btn {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 15px 30px;
                    border: none;
                    border-radius: 25px;
                    font-size: 1.1em;
                    font-weight: bold;
                    cursor: pointer;
                    transition: transform 0.2s;
                    display: inline-block;
                    margin: 10px 5px;
                    text-decoration: none;
                }
                .btn:hover {
                    transform: translateY(-2px);
                }
                .btn-secondary {
                    background: #718096;
                }
                .install-section {
                    background: #f7fafc;
                    border: 2px solid #e2e8f0;
                    border-radius: 10px;
                    padding: 30px;
                    margin: 30px 0;
                    text-align: center;
                }
                .success {
                    background: #c6f6d5;
                    border: 1px solid #68d391;
                    border-radius: 5px;
                    padding: 15px;
                    margin: 20px 0;
                    color: #276749;
                }
                .error {
                    background: #fed7d7;
                    border: 1px solid #fc8181;
                    border-radius: 5px;
                    padding: 15px;
                    margin: 20px 0;
                    color: #9b2c2c;
                }
                .info {
                    background: #bee3f8;
                    border: 1px solid #63b3ed;
                    border-radius: 5px;
                    padding: 15px;
                    margin: 20px 0;
                    color: #2c5282;
                }
                code {
                    background: #2d3748;
                    color: #68d391;
                    padding: 8px 12px;
                    border-radius: 5px;
                    font-family: 'Monaco', 'Consolas', monospace;
                    display: inline-block;
                    margin: 10px 0;
                }
                .help-text {
                    font-size: 0.9em;
                    color: #718096;
                    margin-top: 5px;
                }
                hr {
                    border: none;
                    height: 2px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    margin: 40px 0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>⚡ SKTorrent Real-Debrid Addon</h1>
                <p class="subtitle">Streamování přes Real-Debrid s torrenty ze SKTorrent.eu</p>

                <div class="status-grid">
                    <div class="status-card ${config.REALDEBRID_API_KEY ? 'status-active' : 'status-inactive'}">
                        <h3>Real-Debrid</h3>
                        <p>${config.REALDEBRID_API_KEY ? '✅ Aktivní' : '❌ Nenastaven'}</p>
                    </div>
                    <div class="status-card ${config.SKT_UID && config.SKT_PASS ? 'status-active' : 'status-inactive'}">
                        <h3>SKTorrent.eu</h3>
                        <p>${config.SKT_UID && config.SKT_PASS ? '✅ Přihlášen' : '❌ Nepřihlášen'}</p>
                    </div>
                </div>

                <hr>

                <h2>⚙️ Konfigurace</h2>
                <form id="configForm">
                    <h3>1. Real-Debrid nastavení</h3>
                    <div class="form-group">
                        <label for="rd_api_key">Real-Debrid API klíč:</label>
                        <input type="password" id="rd_api_key" name="rd_api_key" 
                               value="${config.REALDEBRID_API_KEY}" 
                               placeholder="Vložte váš RD API klíč">
                        <p class="help-text">Získejte na real-debrid.com → Account → API</p>
                    </div>

                    <h3>2. SKTorrent.eu přihlášení</h3>
                    <div class="info">
                        <strong>Jak získat přihlašovací údaje:</strong><br>
                        1. Přihlaste se na sktorrent.eu<br>
                        2. Otevřete Developer Tools (F12) → Network<br>
                        3. Obnovte stránku a najděte cookies: uid a pass<br>
                        4. Zkopírujte hodnoty sem
                    </div>
                    
                    <div class="form-group">
                        <label for="skt_uid">SKTorrent UID:</label>
                        <input type="text" id="skt_uid" name="skt_uid" 
                               value="${config.SKT_UID}" 
                               placeholder="Vaše SKT user ID">
                    </div>
                    
                    <div class="form-group">
                        <label for="skt_pass">SKTorrent Pass Hash:</label>
                        <input type="password" id="skt_pass" name="skt_pass" 
                               value="${config.SKT_PASS}" 
                               placeholder="Váš SKT pass hash">
                    </div>

                    <button type="submit" class="btn">💾 Uložit konfiguraci</button>
                    <button type="button" class="btn btn-secondary" onclick="testConfig()">🧪 Otestovat</button>
                </form>

                <div id="message"></div>

                <div class="install-section">
                    <h2>📥 Instalace do Stremio</h2>
                    ${config.REALDEBRID_API_KEY && config.SKT_UID ? `
                        <div class="success">✅ Addon je připraven k instalaci!</div>
                        <p><strong>Manifest URL:</strong></p>
                        <code>${req.protocol}://${req.get('host')}/manifest.json</code>
                        <br><br>
                        <a href="/manifest.json" class="btn">📋 Zobrazit manifest</a>
                        <a href="stremio://${req.get('host')}/manifest.json" class="btn">⚡ Instalovat do Stremio</a>
                    ` : `
                        <div class="error">⚠️ Nejprve dokončete konfiguraci výše</div>
                    `}
                </div>
            </div>

            <script>
                document.getElementById('configForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const config = {
                        REALDEBRID_API_KEY: formData.get('rd_api_key'),
                        SKT_UID: formData.get('skt_uid'),
                        SKT_PASS: formData.get('skt_pass')
                    };

                    try {
                        const response = await fetch('/config', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(config)
                        });

                        const result = await response.json();
                        const messageDiv = document.getElementById('message');
                        
                        if (response.ok) {
                            messageDiv.innerHTML = '<div class="success">✅ ' + result.message + '</div>';
                            setTimeout(() => location.reload(), 2000);
                        } else {
                            messageDiv.innerHTML = '<div class="error">❌ ' + result.error + '</div>';
                        }
                    } catch (error) {
                        document.getElementById('message').innerHTML = 
                            '<div class="error">❌ Chyba při ukládání: ' + error.message + '</div>';
                    }
                });

                async function testConfig() {
                    const messageDiv = document.getElementById('message');
                    messageDiv.innerHTML = '<div class="info">🔄 Testování konfigurace...</div>';
                    
                    try {
                        const response = await fetch('/test-config');
                        const result = await response.json();
                        
                        if (result.success) {
                            messageDiv.innerHTML = '<div class="success">✅ ' + result.message + '</div>';
                        } else {
                            messageDiv.innerHTML = '<div class="error">❌ ' + result.message + '</div>';
                        }
                    } catch (error) {
                        messageDiv.innerHTML = '<div class="error">❌ Chyba při testování</div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Endpoint pro ukládání konfigurace
app.post('/config', async (req, res) => {
    try {
        const newConfig = {
            SKT_UID: req.body.SKT_UID || "",
            SKT_PASS: req.body.SKT_PASS || "",
            REALDEBRID_API_KEY: req.body.REALDEBRID_API_KEY || ""
        };

        await saveConfig(newConfig);
        await initializeRD();

        res.json({ success: true, message: 'Konfigurace uložena! Restartujte addon.' });
    } catch (error) {
        res.status(500).json({ error: 'Chyba při ukládání konfigurace' });
    }
});

// Endpoint pro testování konfigurace
app.get('/test-config', async (req, res) => {
    try {
        let rdOk = false;
        let sktOk = false;

        // Test Real-Debrid
        if (config.REALDEBRID_API_KEY) {
            try {
                const rdTest = new RealDebridAPI(config.REALDEBRID_API_KEY);
                await axios.get('https://api.real-debrid.com/rest/1.0/user', {
                    headers: { 'Authorization': `Bearer ${config.REALDEBRID_API_KEY}` },
                    timeout: 5000
                });
                rdOk = true;
            } catch (e) {
                console.error('RD test failed:', e.message);
            }
        }

        // Test SKTorrent
        if (config.SKT_UID && config.SKT_PASS) {
            try {
                const response = await axios.get(BASE_URL, {
                    headers: { Cookie: `uid=${config.SKT_UID}; pass=${config.SKT_PASS}` },
                    timeout: 5000
                });
                sktOk = response.status === 200;
            } catch (e) {
                console.error('SKT test failed:', e.message);
            }
        }

        const messages = [];
        if (rdOk) messages.push('Real-Debrid OK');
        else messages.push('Real-Debrid CHYBA');
        
        if (sktOk) messages.push('SKTorrent OK');
        else messages.push('SKTorrent CHYBA');

        res.json({
            success: rdOk && sktOk,
            message: messages.join(', ')
        });
    } catch (error) {
        res.json({ success: false, message: 'Test selhal' });
    }
});

// RD Processor endpoint s proxy streamem
app.get('/process/:infoHash', async (req, res) => {
    const { infoHash } = req.params;
    const now = Date.now();

    if (!rd) {
        return res.status(503).json({ error: 'Real-Debrid není nakonfigurován' });
    }

    try {
        console.log(`🚀 Real-Debrid požadavek pro: ${infoHash}`);

        // 1. Kontrola cache
        const cached = rdCache.get(infoHash);
        if (cached && cached.expiresAt > now && cached.links) {
            console.log(`🎯 Cache HIT pro ${infoHash}`);
            
            try {
                const streamResponse = await axios.get(cached.links[0].url, {
                    responseType: 'stream',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Range': req.headers.range || 'bytes=0-'
                    }
                });

                res.set({
                    'Content-Type': streamResponse.headers['content-type'] || 'video/mp4',
                    'Content-Length': streamResponse.headers['content-length'],
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache'
                });

                if (req.headers.range && streamResponse.status === 206) {
                    res.status(206);
                    res.set('Content-Range', streamResponse.headers['content-range']);
                }

                return streamResponse.data.pipe(res);

            } catch (proxyError) {
                console.error(`❌ Proxy stream chyba: ${proxyError.message}`);
                return res.status(503).json({ error: 'Chyba proxy streamu' });
            }
        }

        // 2. Kontrola aktivního zpracování
        if (activeProcessing.has(infoHash)) {
            console.log(`⏳ Čekám na aktivní zpracování pro ${infoHash}`);
            try {
                const result = await activeProcessing.get(infoHash);
                if (result && result.length > 0) {
                    console.log(`✅ Zpracování dokončeno pro ${infoHash}`);
                    
                    const streamResponse = await axios.get(result[0].url, {
                        responseType: 'stream',
                        timeout: 30000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Range': req.headers.range || 'bytes=0-'
                        }
                    });

                    res.set({
                        'Content-Type': streamResponse.headers['content-type'] || 'video/mp4',
                        'Content-Length': streamResponse.headers['content-length'],
                        'Accept-Ranges': 'bytes',
                        'Cache-Control': 'no-cache'
                    });

                    if (req.headers.range && streamResponse.status === 206) {
                        res.status(206);
                        res.set('Content-Range', streamResponse.headers['content-range']);
                    }

                    return streamResponse.data.pipe(res);
                }
            } catch (error) {
                console.log(`❌ Aktivní zpracování selhalo: ${error.message}`);
                activeProcessing.delete(infoHash);
            }
        }

        // 3. Nové zpracování
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const processingPromise = rd.addMagnetIfNotExists(magnetLink, infoHash, 2);
        activeProcessing.set(infoHash, processingPromise);

        try {
            const rdLinks = await processingPromise;
            activeProcessing.delete(infoHash);

            if (rdLinks && rdLinks.length > 0) {
                // Uložit do cache
                rdCache.set(infoHash, {
                    timestamp: now,
                    links: rdLinks,
                    expiresAt: now + CACHE_DURATION
                });

                console.log(`✅ RD zpracování úspěšné pro ${infoHash}`);

                const streamResponse = await axios.get(rdLinks[0].url, {
                    responseType: 'stream',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Range': req.headers.range || 'bytes=0-'
                    }
                });

                res.set({
                    'Content-Type': streamResponse.headers['content-type'] || 'video/mp4',
                    'Content-Length': streamResponse.headers['content-length'],
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache'
                });

                if (req.headers.range && streamResponse.status === 206) {
                    res.status(206);
                    res.set('Content-Range', streamResponse.headers['content-range']);
                }

                streamResponse.data.pipe(res);

                streamResponse.data.on('error', (error) => {
                    console.error(`❌ Stream error: ${error.message}`);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Stream error' });
                    }
                });

                return;
            }
        } catch (error) {
            activeProcessing.delete(infoHash);
            console.error(`❌ RD zpracování selhalo: ${error.message}`);
        }

        return res.status(503).json({
            error: 'Real-Debrid zpracování selhalo',
            message: 'Zkuste to znovu později'
        });

    } catch (error) {
        activeProcessing.delete(infoHash);
        console.error(`❌ Chyba Real-Debrid: ${error.message}`);
        return res.status(503).json({ error: 'Real-Debrid server error' });
    }
});

// Cleanup rutina
setInterval(() => {
    const now = Date.now();

    // Vyčistit expirovanou cache
    for (const [infoHash, cached] of rdCache.entries()) {
        if (cached.expiresAt <= now) {
            rdCache.delete(infoHash);
            console.log(`🧹 Vyčištěn cache pro ${infoHash}`);
        }
    }

    // Vyčistit staré zpracování
    const oldProcessingLimit = now - (5 * 60 * 1000);
    for (const [infoHash] of activeProcessing.entries()) {
        activeProcessing.delete(infoHash);
        console.log(`🧹 Vyčištěno zpracování pro ${infoHash}`);
    }
}, 60000);

// Převod addon na Express router
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Spuštění serveru
async function start() {
    await loadConfig();
    await initializeRD();
    
    const PORT = process.env.PORT || 7000;
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 SKTorrent Real-Debrid addon běží na portu ${PORT}`);
        console.log('🌐 Otevřete webovou adresu pro konfiguraci');
        console.log('📋 Manifest URL: /manifest.json');
    });
}

start();
