// SKTorrent RealDebrid-Only Stremio addon optimalizovaný pro Render.com
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const express = require("express");

// Real-Debrid API integrace
const RealDebridAPI = require('./realdebrid');

// SKTorrent údaje nyní z databáze uživatelů
let SKT_UID = process.env.SKT_UID || "";
let SKT_PASS = process.env.SKT_PASS || "";

console.log('🚀 SKTorrent RealDebrid-Only addon spouštění...');

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent.realdebrid",
    version: "3.0.0",
    name: "SKTorrent RealDebrid",
    description: "SKTorrent.eu obsah přes Real-Debrid s webovým nastavením",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

// In-memory storage pro uživatelské údaje
const users = new Map(); // userId -> { rdApiKey, sktUid, sktPass }

// Utility funkce
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

// Získání názvu z IMDb
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
        console.log(`[DEBUG] 🌝 Lokalizovaný název: ${title}`);
        console.log(`[DEBUG] 🇳️ Originální název: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] Chyba při získávání z IMDb:", err.message);
        return null;
    }
}

// Vyhledávání torrentů na SKTorrent s user credentials
async function searchTorrents(query, sktUid = SKT_UID, sktPass = SKT_PASS) {
    console.log(`[INFO] 🔎 Hledám '${query}' na SKTorrent...`);
    
    if (!sktUid || !sktPass) {
        console.error("[ERROR] Chybí SKTorrent přihlašovací údaje");
        return [];
    }
    
    try {
        const session = axios.create({
            headers: { Cookie: `uid=${sktUid}; pass=${sktPass}` },
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

// Získání torrent info s user credentials
async function getTorrentInfo(url, sktUid = SKT_UID, sktPass = SKT_PASS) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${sktUid}; pass=${sktPass}`,
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
let addonBaseUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:7000';

// Cache pro RD optimalizaci
const activeProcessing = new Map();
const rdCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minut

// Stream handler - pouze Real-Debrid s přímými redirecty
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n====== 🎮 STREAM Požadavek pro typ='${type}' id='${id}' ======`);

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    // Pro testování, vracíme prázdné streamy pokud nemáme user data
    const userId = args.extra?.userId;
    if (!userId || !users.has(userId)) {
        console.log("❌ Uživatel nenalezen nebo není přihlášen - vracím prázdný seznam");
        return { streams: [] };
    }

    const userConfig = users.get(userId);
    const { sktUid, sktPass } = userConfig;

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
        torrents = await searchTorrents(q, sktUid, sktPass);
        if (torrents.length > 0) break;
    }

    if (torrents.length === 0) {
        console.log(`[INFO] ❌ Žádné torrenty nenalezeny`);
        return { streams: [] };
    }

    const streams = [];
    console.log(`🎮 Generuji pouze Real-Debrid streamy s přímými redirecty...`);

    // Zpracování pouze pro Real-Debrid
    for (const torrent of torrents.slice(0, 8)) {
        const torrentInfo = await getTorrentInfo(torrent.downloadUrl, sktUid, sktPass);
        if (!torrentInfo) continue;

        let cleanedTitle = torrent.name.replace(/^Stiahni si\s*/i, "").trim();
        const categoryPrefix = torrent.category.trim().toLowerCase();
        if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
            cleanedTitle = cleanedTitle.slice(torrent.category.length).trim();
        }

        const quality = extractQuality(torrent.name);
        const langMatches = torrent.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? ` ${flags.join("/")}` : "";

        streams.push({
            name: `⚡ RealDebrid ${quality}`,
            title: `${cleanedTitle}\n👥 ${torrent.seeds} seeders | 📦 ${torrent.size}${flagsText}`,
            url: `${addonBaseUrl}/stream/${userId}/${torrentInfo.infoHash}`,
            behaviorHints: { 
                bingeGroup: `rd-${quality}`,
                countryWhitelist: ['CZ', 'SK']
            }
        });
    }

    console.log(`[INFO] ✅ Odesílám ${streams.length} RealDebrid streamů`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Požadavek na katalog pro typ='${type}' id='${id}'`);
    return { metas: [] };
});

// Express server
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS pro všechny požadavky
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Health check endpoint pro Render.com
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            sktorrent: SKT_UID && SKT_PASS ? 'configured' : 'not configured',
            cache: `${rdCache.size} items`,
            activeProcessing: activeProcessing.size
        },
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// Utility funkce
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Úvodní stránka s kompletním nastavením
app.get('/', (req, res) => {
    const stats = {
        totalUsers: users.size,
        cacheSize: rdCache.size,
        uptime: formatUptime(process.uptime())
    };

    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>SKTorrent RealDebrid Addon</title>
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
        .setup-section {
            background: #f7fafc;
            border: 2px solid #e2e8f0;
            border-radius: 10px;
            padding: 30px;
            margin: 30px 0;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #4a5568;
        }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 16px;
            box-sizing: border-box;
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
            font-weight: bold;
            font-size: 1.1em;
            cursor: pointer;
            transition: transform 0.2s;
            width: 100%;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .install-url {
            background: #2d3748;
            color: #68d391;
            padding: 15px;
            border-radius: 8px;
            font-family: monospace;
            word-break: break-all;
            margin: 20px 0;
            display: none;
        }
        .success {
            background: #c6f6d5;
            border: 2px solid #68d391;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
            color: #276749;
            display: none;
        }
        .error {
            background: #fed7d7;
            border: 2px solid #fc8181;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
            color: #9b2c2c;
            display: none;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: #f7fafc;
            border-radius: 10px;
            padding: 20px;
            text-align: center;
            border: 2px solid #e2e8f0;
        }
        .instructions {
            background: #e6fffa;
            border: 2px solid #38b2ac;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
        }
        .instructions-skt {
            background: #fef5e7;
            border: 2px solid #ed8936;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
        }
        .copy-btn {
            background: #38a169;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 5px;
            cursor: pointer;
            margin-left: 10px;
        }
        .step-number {
            background: #667eea;
            color: white;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            margin-right: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ SKTorrent RealDebrid</h1>
        <p class="subtitle">Kompletní nastavení pro přehrávání SKTorrent obsahu přes Real-Debrid</p>

        <div class="setup-section">
            <h2><span class="step-number">1</span>Real-Debrid API nastavení</h2>
            
            <div class="instructions">
                <h3>📋 Jak získat Real-Debrid API klíč:</h3>
                <ol>
                    <li>Přihlaste se na <a href="https://real-debrid.com" target="_blank">Real-Debrid.com</a></li>
                    <li>Přejděte na <strong>Account → API</strong></li>
                    <li>Klikněte na <strong>Generate</strong></li>
                    <li>Zkopírujte API klíč a vložte ho níže</li>
                </ol>
            </div>

            <h2><span class="step-number">2</span>SKTorrent.eu přihlašovací údaje</h2>
            
            <div class="instructions-skt">
                <h3>🔑 Jak získat SKTorrent údaje:</h3>
                <ol>
                    <li>Přihlaste se na <a href="https://sktorrent.eu" target="_blank">SKTorrent.eu</a></li>
                    <li>Otevřete Developer Tools (F12)</li>
                    <li>Přejděte na tab <strong>Application</strong> (nebo <strong>Storage</strong>)</li>
                    <li>V levém menu rozbalte <strong>Cookies</strong></li>
                    <li>Klikněte na <strong>https://sktorrent.eu</strong></li>
                    <li>Najděte a zkopírujte hodnoty:
                        <ul>
                            <li><code>uid</code> - číselná hodnota (např. 123456)</li>
                            <li><code>pass</code> - dlouhý hash (např. abc123def456...)</li>
                        </ul>
                    </li>
                </ol>
                <p><strong>💡 Tip:</strong> Pokud nevidíte tyto cookies, zkuste se znovu přihlásit na SKTorrent.eu</p>
                <p><strong>⚠️ Poznámka:</strong> Tyto údaje se ukládají pouze v paměti serveru a nejsou nikde perzistentně ukládány.</p>
            </div>

            <form id="setupForm">
                <div class="form-group">
                    <label for="rdApiKey">Real-Debrid API klíč:</label>
                    <input type="password" id="rdApiKey" placeholder="Vložte váš Real-Debrid API klíč" required>
                </div>
                
                <div class="form-row">
                    <div class="form-group">
                        <label for="sktUid">SKTorrent UID:</label>
                        <input type="text" id="sktUid" placeholder="uid hodnota z cookies" required>
                    </div>
                    <div class="form-group">
                        <label for="sktPass">SKTorrent Pass:</label>
                        <input type="password" id="sktPass" placeholder="pass hodnota z cookies" required>
                    </div>
                </div>
                
                <button type="submit" class="btn">💾 Dokončit nastavení a vygenerovat addon</button>
            </form>

            <div id="success" class="success">
                <h3>✅ Úspěšně nakonfigurováno!</h3>
                <p>Váš addon je připraven k instalaci do Stremio.</p>
                <div id="installUrl" class="install-url"></div>
                <button type="button" class="copy-btn" onclick="copyToClipboard()">📋 Kopírovat URL</button>
                <br><br>
                <a href="#" id="stremioLink" class="btn">🚀 Instalovat do Stremio</a>
            </div>

            <div id="error" class="error">
                <h3>❌ Chyba</h3>
                <p id="errorMessage"></p>
            </div>
        </div>

        <div class="stats">
            <div class="stat-card">
                <h3>👥 Uživatelé</h3>
                <p style="font-size: 2em; margin: 0;">${stats.totalUsers}</p>
            </div>
            <div class="stat-card">
                <h3>💾 Cache</h3>
                <p style="font-size: 2em; margin: 0;">${stats.cacheSize}</p>
            </div>
            <div class="stat-card">
                <h3>⏱️ Uptime</h3>
                <p style="font-size: 1.2em; margin: 0;">${stats.uptime}</p>
            </div>
        </div>

        <div style="text-align: center; margin-top: 40px; color: #718096;">
            <p><strong>Powered by:</strong> Real-Debrid API + SKTorrent.eu + Direct Streaming</p>
            <p><small>Žádné proxy streaming - přímé redirecty na Real-Debrid</small></p>
        </div>
    </div>

    <script>
        let generatedUrl = '';

        document.getElementById('setupForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const rdApiKey = document.getElementById('rdApiKey').value;
            const sktUid = document.getElementById('sktUid').value;
            const sktPass = document.getElementById('sktPass').value;
            const errorDiv = document.getElementById('error');
            const successDiv = document.getElementById('success');
            
            errorDiv.style.display = 'none';
            successDiv.style.display = 'none';
            
            try {
                const response = await fetch('/setup', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ rdApiKey, sktUid, sktPass })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    generatedUrl = result.manifestUrl;
                    document.getElementById('installUrl').textContent = generatedUrl;
                    document.getElementById('stremioLink').href = 'stremio://' + generatedUrl.replace('https://', '').replace('http://', '');
                    successDiv.style.display = 'block';
                } else {
                    document.getElementById('errorMessage').textContent = result.error;
                    errorDiv.style.display = 'block';
                }
            } catch (error) {
                document.getElementById('errorMessage').textContent = 'Chyba připojení k serveru';
                errorDiv.style.display = 'block';
            }
        });

        function copyToClipboard() {
            navigator.clipboard.writeText(generatedUrl).then(() => {
                alert('URL zkopírováno do schránky!');
            });
        }
    </script>
</body>
</html>`);
});

// Debug endpoint pro testování SKTorrent credentials
app.post('/test-skt', async (req, res) => {
    const { sktUid, sktPass } = req.body;
    
    if (!sktUid || !sktPass) {
        return res.status(400).json({ error: 'Chybí SKTorrent údaje' });
    }
    
    try {
        console.log(`Testing SKT credentials: uid=${sktUid}, pass=${sktPass.substring(0, 10)}...`);
        
        const testResponse = await axios.get(BASE_URL, {
            headers: { 
                Cookie: `uid=${sktUid}; pass=${sktPass}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        
        const responseText = testResponse.data;
        const checks = {
            status: testResponse.status,
            hasOdhlas: responseText.includes('Odhlás'),
            hasLogout: responseText.includes('logout'),
            hasPrihlaseny: responseText.includes('prihlaseny'),
            hasMojUcet: responseText.includes('Môj účet'),
            hasPrihlasit: responseText.includes('Prihlásiť'),
            responseLength: responseText.length
        };
        
        console.log('SKT test results:', checks);
        
        res.json({
            success: true,
            checks,
            isLoggedIn: checks.hasOdhlas || checks.hasLogout || checks.hasPrihlaseny || checks.hasMojUcet || !checks.hasPrihlasit
        });
        
    } catch (error) {
        console.error('SKT test error:', error.message);
        res.status(500).json({
            error: 'Chyba testování',
            message: error.message
        });
    }
});

// API endpoint pro kompletní nastavení
app.post('/setup', async (req, res) => {
    const { rdApiKey, sktUid, sktPass } = req.body;
    
    if (!rdApiKey || rdApiKey.length < 20) {
        return res.status(400).json({ error: 'Neplatný Real-Debrid API klíč' });
    }
    
    if (!sktUid || !sktPass) {
        return res.status(400).json({ error: 'Chybí SKTorrent přihlašovací údaje' });
    }
    
    try {
        // Test Real-Debrid API klíče
        const testResponse = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
            headers: { 'Authorization': `Bearer ${rdApiKey}` },
            timeout: 10000
        });
        
        if (testResponse.status !== 200) {
            return res.status(400).json({ error: 'Real-Debrid API klíč není platný' });
        }
        
        // Test SKTorrent přihlašovacích údajů
        try {
            const sktTestResponse = await axios.get(BASE_URL, {
                headers: { 
                    Cookie: `uid=${sktUid}; pass=${sktPass}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 15000,
                maxRedirects: 5
            });
            
            console.log(`SKTorrent test response status: ${sktTestResponse.status}`);
            console.log(`SKTorrent response includes login check:`, sktTestResponse.data.includes('Odhlás') || sktTestResponse.data.includes('logout') || sktTestResponse.data.includes('prihlaseny'));
            
            // Více způsobů jak ověřit přihlášení
            const isLoggedIn = sktTestResponse.data.includes('Odhlás') || 
                             sktTestResponse.data.includes('logout') || 
                             sktTestResponse.data.includes('prihlaseny') ||
                             sktTestResponse.data.includes('Môj účet') ||
                             !sktTestResponse.data.includes('Prihlásiť');
            
            if (sktTestResponse.status !== 200 || !isLoggedIn) {
                console.log('SKTorrent validation failed - trying search test instead');
                
                // Fallback: pokus o vyhledávání
                const searchTest = await axios.get(SEARCH_URL, {
                    params: { search: 'test', category: 0 },
                    headers: { 
                        Cookie: `uid=${sktUid}; pass=${sktPass}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 15000
                });
                
                if (searchTest.status !== 200 || searchTest.data.includes('Prihlásiť')) {
                    return res.status(400).json({ error: 'SKTorrent přihlašovací údaje nejsou platné - zkontrolujte UID a Pass hodnoty z cookies' });
                }
            }
        } catch (sktError) {
            console.error('SKTorrent test error:', sktError.message);
            return res.status(400).json({ error: 'Nepodařilo se ověřit SKTorrent přihlašovací údaje - zkontrolujte internetové připojení' });
        }
        
        // Vygenerovat unikátní user ID
        const userId = crypto.randomBytes(16).toString('hex');
        users.set(userId, {
            rdApiKey,
            sktUid,
            sktPass,
            created: Date.now()
        });
        
        const manifestUrl = `${addonBaseUrl}/manifest/${userId}.json`;
        
        console.log(`✅ Nový uživatel nakonfigurován: ${userId}`);
        
        res.json({
            success: true,
            manifestUrl,
            userId
        });
        
    } catch (error) {
        console.error('Chyba při ověření údajů:', error.message);
        if (error.message.includes('Real-Debrid')) {
            res.status(400).json({ error: 'Nepodařilo se ověřit Real-Debrid API klíč' });
        } else {
            res.status(400).json({ error: 'Nepodařilo se ověřit SKTorrent přihlašovací údaje' });
        }
    }
});

// Manifest endpoint s user ID
app.get('/manifest/:userId.json', (req, res) => {
    const { userId } = req.params;
    
    if (!users.has(userId)) {
        return res.status(404).json({ error: 'Uživatel nenalezen' });
    }
    
    // Získat manifest přímo, ne zabalený
    const manifest = builder.getInterface().manifest;
    
    // Přidat CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Content-Type', 'application/json');
    
    console.log(`📋 Manifest požadavek pro uživatele: ${userId}`);
    
    res.json(manifest);
});

// Základní manifest bez user ID (pro testování)
app.get('/manifest.json', (req, res) => {
    const manifest = builder.getInterface().manifest;
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Content-Type', 'application/json');
    
    console.log(`📋 Základní manifest požadavek`);
    
    res.json(manifest);
});

// Stream endpoint s přímými redirecty (bez proxy)
app.get('/stream/:userId/:infoHash', async (req, res) => {
    const { userId, infoHash } = req.params;
    
    if (!users.has(userId)) {
        return res.status(401).json({ error: 'Neautorizovaný přístup' });
    }
    
    const userConfig = users.get(userId);
    const { rdApiKey } = userConfig;
    const rd = new RealDebridAPI(rdApiKey);
    
    try {
        console.log(`🚀 RealDebrid stream požadavek pro: ${infoHash} (user: ${userId})`);
        
        // Kontrola cache
        const cacheKey = `${userId}:${infoHash}`;
        const cached = rdCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() && cached.links) {
            console.log(`🎯 Cache HIT pro ${infoHash}`);
            // Přímý redirect na RealDebrid URL
            return res.redirect(302, cached.links[0].url);
        }
        
        // RealDebrid zpracování
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const rdLinks = await rd.addMagnetIfNotExists(magnetLink, infoHash, 3);
        
        if (rdLinks && rdLinks.length > 0) {
            // Uložit do cache s user-specific key
            rdCache.set(cacheKey, {
                timestamp: Date.now(),
                links: rdLinks,
                expiresAt: Date.now() + CACHE_DURATION
            });
            
            console.log(`✅ RD zpracování úspěšné pro ${infoHash} - přímý redirect`);
            
            // Přímý redirect na RealDebrid URL
            return res.redirect(302, rdLinks[0].url);
        }
        
        console.log(`⚠️ RealDebrid zpracování se nezdařilo pro ${infoHash}`);
        return res.status(503).json({
            error: 'RealDebrid zpracování se nezdařilo',
            message: 'Torrent není dostupný v RealDebrid'
        });
        
    } catch (error) {
        console.error(`❌ Chyba stream zpracování: ${error.message}`);
        return res.status(503).json({
            error: 'Chyba serveru',
            message: error.message
        });
    }
});

// Cleanup cache rutina
setInterval(() => {
    const now = Date.now();
    
    // Vyčistit expirovanou cache
    for (const [cacheKey, cached] of rdCache.entries()) {
        if (cached.expiresAt <= now) {
            rdCache.delete(cacheKey);
            console.log(`🧹 Vyčištěn expirovaný cache pro ${cacheKey}`);
        }
    }
    
    // Vyčistir staré uživatele (starší než 30 dní)
    const oldUserLimit = now - (30 * 24 * 60 * 60 * 1000);
    for (const [userId, userData] of users.entries()) {
        if (userData.created < oldUserLimit) {
            users.delete(userId);
            console.log(`🧹 Vyčištěn starý uživatel: ${userId}`);
        }
    }
}, 60000); // Každou minutu

// Custom middleware pro user ID přenos
app.use((req, res, next) => {
    // Pro stream requesty, získat user ID z URL
    const streamMatch = req.url.match(/\/stream\/([a-f0-9]{32})\//);
    if (streamMatch) {
        req.userId = streamMatch[1];
    }
    
    next();
});

// Mount addon router PŘED custom endpointy
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error.message);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: 'Endpoint not found'
    });
});

// Spuštění serveru
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SKTorrent RealDebrid addon běží na portu ${PORT}`);
    console.log(`🌐 Externí URL: ${addonBaseUrl}`);
    console.log(`🔧 Fallback SKTorrent účet: ${SKT_UID ? 'Nakonfigurován' : 'NENÍ NAKONFIGUROVÁN'}`);
    console.log(`💾 Cache: In-memory storage s user-specific keys`);
    console.log(`🎯 Streaming: Přímé redirecty na Real-Debrid (bez proxy)`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    if (!SKT_UID || !SKT_PASS) {
        console.warn('⚠️ VAROVÁNÍ: Fallback SKT_UID nebo SKT_PASS nejsou nastaveny - pouze webové nastavení!');
    }
});