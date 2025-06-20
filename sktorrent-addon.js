// SKTorrent RealDebrid-Only Stremio addon - Čistá verze
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const express = require("express");

// Real-Debrid API integrace
const RealDebridAPI = require('./realdebrid');

console.log('🚀 SKTorrent RealDebrid addon spouštění...');

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

// In-memory storage pro uživatelské údaje
const users = new Map(); // userId -> { rdApiKey, sktUid, sktPass }

// Cache pro RD optimalizaci
const rdCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minut

// Globální proměnné
let addonBaseUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:7000';

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

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

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Získání názvu z IMDb s preferencí EN/CZ
async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 5000
        });
        const $ = cheerio.load(res.data);
        
        // Získáme originální název (většinou anglický)
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = null;
        let title = null;
        
        if (ldJson) {
            try {
                const json = JSON.parse(ldJson);
                if (json && json.name) {
                    originalTitle = decode(json.name.trim());
                }
            } catch (e) {}
        }
        
        // Fallback na title tag
        if (!originalTitle) {
            const titleRaw = $('title').text().split(' - ')[0].trim();
            originalTitle = decode(titleRaw);
        }
        
        // Vyčistíme názvy - odstraníme rok a extra info
        const cleanTitle = originalTitle.replace(/\s*\(\d{4}\)/, '').replace(/\s*\(TV.*?\)/, '').trim();
        
        console.log(`[DEBUG] 🌍 Originální název: "${originalTitle}"`);
        console.log(`[DEBUG] 🧹 Vyčištěný název: "${cleanTitle}"`);
        
        // Vracíme pouze anglický/originální název
        return { 
            title: cleanTitle,           // Vyčištěný anglický název
            originalTitle: cleanTitle    // Stejný jako title pro konzistenci
        };
        
    } catch (err) {
        console.error("[ERROR] Chyba při získávání z IMDb:", err.message);
        return null;
    }
}

// Vyhledávání torrentů na SKTorrent
async function searchTorrents(query, sktUid, sktPass) {
    console.log(`[INFO] 🔎 Hledám '${query}' na SKTorrent...`);
    
    if (!sktUid || !sktPass) {
        console.error("[ERROR] Chybí SKTorrent přihlašovací údaje");
        return [];
    }
    
    try {
        const session = axios.create({
            headers: { 
                Cookie: `uid=${sktUid}; pass=${sktPass}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
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

// Získání torrent info
async function getTorrentInfo(url, sktUid, sktPass) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${sktUid}; pass=${sktPass}`,
                Referer: BASE_URL,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

// Vytvoření addon builderu - minimální katalog + stream
const builder = addonBuilder({
    id: "org.stremio.sktorrent.realdebrid",
    version: "3.0.0", 
    name: "SKTorrent RealDebrid",
    description: "SKTorrent.eu obsah přes Real-Debrid s webovým nastavením",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "empty", name: "Konfigurace" }
    ],
    resources: ["catalog", "stream"],
    idPrefixes: ["tt"], // IMDb IDs
    behaviorHints: {
        adult: false,
        p2p: false
    }
});

// POUZE stream handler - žádné catalog handlery
// (Odstranil catalog handler úplně)

// Stream handler - pouze Real-Debrid s přímými redirecty
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    console.log(`\n====== 🎮 STREAM Handler pro typ='${type}' id='${id}' ======`);
    console.log(`🔍 Args:`, JSON.stringify(args, null, 2));

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    // Zkusíme získat userId z různých zdrojů
    let userId = global.currentUserId;
    
    // Pokud nemáme userId nebo user neexistuje, použijeme prvního dostupného
    if (!userId || !users.has(userId)) {
        if (users.size > 0) {
            userId = Array.from(users.keys())[0]; // Vezmi prvního uživatele
            console.log(`🔄 CurrentUserId nefunguje, používám prvního dostupného: ${userId}`);
        }
    }
    
    console.log(`🆔 Detekovaný userId: ${userId}`);
    console.log(`📊 Celkem uživatelů v systému: ${users.size}`);

    // FALLBACK pro testování - použijeme pevné SKT údaje pokud jsou v ENV
    if ((!userId || !users.has(userId)) && users.size === 0) {
        const fallbackSktUid = process.env.SKT_UID;
        const fallbackSktPass = process.env.SKT_PASS;
        const fallbackRdKey = process.env.RD_API_KEY;
        
        if (fallbackSktUid && fallbackSktPass && fallbackRdKey) {
            console.log(`🔄 Používám fallback ENV credentials`);
            
            // Dočasně vytvoříme fallback uživatele
            const fallbackUserId = 'fallback-user';
            users.set(fallbackUserId, {
                rdApiKey: fallbackRdKey,
                sktUid: fallbackSktUid,
                sktPass: fallbackSktPass,
                created: Date.now()
            });
            userId = fallbackUserId;
            
            console.log(`✅ Fallback uživatel vytvořen: ${userId}`);
        }
    }

    // Pokud stále nemáme userId nebo user data, vracíme prázdné streamy
    if (!userId || !users.has(userId)) {
        console.log("❌ Žádný uživatel k dispozici - vracím prázdný seznam");
        console.log("💡 Hint: Použijte webové nastavení pro konfiguraci nebo nastavte ENV proměnné");
        return { streams: [] };
    }

    const userConfig = users.get(userId);
    const { sktUid, sktPass } = userConfig;
    
    console.log(`✅ Používám uživatele: ${userId}`);
    console.log(`🔑 SKT údaje: uid=${sktUid}, pass=${sktPass ? 'SET' : 'MISSING'}`);

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) {
        console.log("❌ Nepodařilo se získat název z IMDb");
        return { streams: [] };
    }

    const { title, originalTitle } = titles;
    console.log(`🎬 Hledám: "${title}" (vyčištěný anglický název)`);
    
    const queries = new Set();
    
    // Použijeme pouze vyčištěný anglický název
    const baseTitle = title;
    const noDia = removeDiacritics(baseTitle);
    const short = shortenTitle(noDia);

    if (type === 'series' && season && episode) {
        const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        [baseTitle, noDia, short].forEach(b => {
            queries.add(b + epTag);
            queries.add((b + epTag).replace(/[\':]/g, ''));
            queries.add((b + epTag).replace(/[\':]/g, '').replace(/\s+/g, '.'));
        });
    } else {
        [baseTitle, noDia, short].forEach(b => {
            queries.add(b);
            queries.add(b.replace(/[\':]/g, ''));
            queries.add(b.replace(/[\':]/g, '').replace(/\s+/g, '.'));
            
            // Přidáme varianty bez "The"
            if (b.startsWith('The ')) {
                const withoutThe = b.substring(4);
                queries.add(withoutThe);
                queries.add(withoutThe.replace(/[\':]/g, ''));
            }
        });
    }

    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hledám '${q}'`);
        torrents = await searchTorrents(q, sktUid, sktPass);
        if (torrents.length > 0) break;
        
        // Limit attempts for debugging
        if (attempt > 3) {
            console.log(`⚠️ Omezuji pokusy na 3 pro debugging`);
            break;
        }
    }

    if (torrents.length === 0) {
        console.log(`[INFO] ❌ Žádné torrenty nenalezeny pro "${title}"`);
        return { streams: [] };
    }

    const streams = [];
    console.log(`🎮 Generuji ${torrents.length} RealDebrid streamů...`);

    // Zpracování pro Real-Debrid (omezíme na 3 pro rychlost)
    for (const torrent of torrents.slice(0, 3)) {
        const torrentInfo = await getTorrentInfo(torrent.downloadUrl, sktUid, sktPass);
        if (!torrentInfo) {
            console.log(`⚠️ Nepodařilo se zpracovat torrent: ${torrent.name}`);
            continue;
        }

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
        
        console.log(`✅ Přidán stream: ${cleanedTitle} (${quality})`);
    }

    console.log(`[INFO] ✅ Odesílám ${streams.length} RealDebrid streamů`);
    return { streams };
});

// Express server
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS - rozšířené pro Stremio kompatibilitu
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization, Cache-Control');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.header('Access-Control-Max-Age', '3600');
    
    // Stremio specifické headers
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Debug endpoint pro manifest test
app.get('/debug', (req, res) => {
    const manifest = builder.getInterface().manifest;
    
    res.json({
        manifest: manifest,
        users: users.size,
        userList: Array.from(users.keys()),
        cache: rdCache.size,
        currentUserId: global.currentUserId,
        uptime: process.uptime()
    });
});

// Test stream endpoint pro debugging
app.get('/test-stream/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    
    console.log(`🧪 TEST STREAM: ${type}/${id}`);
    
    // Použijeme prvního dostupného uživatele pokud currentUserId nefunguje
    let testUserId = req.query.userId || global.currentUserId;
    
    if (!testUserId || !users.has(testUserId)) {
        if (users.size > 0) {
            testUserId = Array.from(users.keys())[0];
            console.log(`🔄 Používám prvního dostupného uživatele: ${testUserId}`);
        }
    }
    
    // Simulace stream handleru přímo
    try {
        const args = { type, id, extra: {} };
        
        // Volání našeho stream handleru přímo
        const [imdbId, sRaw, eRaw] = id.split(":");
        
        // Debug info
        const debugInfo = {
            args,
            originalUserId: global.currentUserId,
            testUserId: testUserId,
            usersAvailable: users.size,
            userList: Array.from(users.keys()),
            imdbId,
            hasUserData: testUserId && users.has(testUserId)
        };
        
        // Pokud máme uživatele, zkusíme získat název z IMDb
        if (testUserId && users.has(testUserId)) {
            const titles = await getTitleFromIMDb(imdbId);
            debugInfo.imdbTitles = titles;
            
            if (titles) {
                const userConfig = users.get(testUserId);
                const { sktUid, sktPass, rdApiKey } = userConfig;
                
                
                debugInfo.userConfig = {
                    hasSktUid: !!sktUid,
                    hasSktPass: !!sktPass,
                    hasRdApiKey: !!rdApiKey,
                    sktUid: sktUid // Pro debug
                };
                
                // Test SKTorrent credentials nejdřív
                try {
                    console.log(`🧪 Testuji SKTorrent připojení pro UID: ${sktUid}`);
                    const testResponse = await axios.get(`${BASE_URL}`, {
                        headers: { 
                            Cookie: `uid=${sktUid}; pass=${sktPass}`,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        timeout: 10000
                    });
                    
                    debugInfo.sktTest = {
                        status: testResponse.status,
                        connected: testResponse.status === 200,
                        responseLength: testResponse.data?.length || 0,
                        hasLoginIndicator: testResponse.data?.includes('Odhlás') || testResponse.data?.includes('logout')
                    };
                    
                } catch (sktError) {
                    debugInfo.sktTest = {
                        error: sktError.message,
                        connected: false
                    };
                }
                
                // Zkusíme více search queries - pouze anglické názvy
                const baseTitle = titles.title; // Už je vyčištěný anglický název
                const searchQueries = [
                    baseTitle,                           // "The Shawshank Redemption"
                    baseTitle.replace(/^The /, ''),     // "Shawshank Redemption" 
                    baseTitle.split(' ').slice(0, 2).join(' '), // První 2 slova
                    baseTitle.split(' ')[0]              // První slovo
                ].filter((q, i, arr) => arr.indexOf(q) === i); // Unique pouze
                
                debugInfo.searchQueries = searchQueries;
                let totalTorrents = [];
                
                for (let i = 0; i < searchQueries.length; i++) {
                    const query = searchQueries[i];
                    console.log(`🔍 Testuji search ${i+1}: "${query}"`);
                    
                    try {
                        const torrents = await searchTorrents(query, sktUid, sktPass);
                        debugInfo[`search${i+1}`] = {
                            query: query,
                            found: torrents.length,
                            samples: torrents.slice(0, 2).map(t => ({
                                name: t.name?.substring(0, 100) + '...', // Zkrátíme pro debug
                                seeds: t.seeds,
                                size: t.size,
                                category: t.category
                            }))
                        };
                        
                        if (torrents.length > 0) {
                            totalTorrents = totalTorrents.concat(torrents.slice(0, 5)); // Max 5 z každého
                        }
                        
                        // Pokračujeme se všemi queries pro kompletní debug
                    } catch (error) {
                        debugInfo[`search${i+1}`] = {
                            query: query,
                            error: error.message
                        };
                    }
                }
                
                debugInfo.torrentsFound = totalTorrents.length;
                debugInfo.totalTorrents = totalTorrents.slice(0, 3).map(t => ({
                    name: t.name?.substring(0, 80) + '...',
                    seeds: t.seeds,
                    size: t.size
                }));
            }
        }
        
        res.json({
            success: true,
            debug: debugInfo
        });
        
    } catch (error) {
        console.error('Test stream error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack,
            args: { type, id },
            originalUserId: global.currentUserId,
            usersAvailable: users.size
        });
    }
});
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        users: users.size,
        cache: rdCache.size,
        uptime: process.uptime()
    });
});

// Middleware pro nastavení userId pro stream requesty
app.use((req, res, next) => {
    const manifestMatch = req.url.match(/\/manifest\/([a-f0-9]{32})\.json/);
    const streamMatch = req.url.match(/\/stream\/([a-f0-9]{32})\//);
    
    if (manifestMatch || streamMatch) {
        const userId = manifestMatch ? manifestMatch[1] : streamMatch[1];
        req.userId = userId; // Nastavíme do req objektu
        global.currentUserId = userId; // Backup do globální proměnné
        console.log(`🆔 Nastavuji userId: ${userId} pro ${req.url}`);
    }
    
    next();
});

// Custom stream endpoint pro user-specific requesty  
app.get('/stream/:type/:id', async (req, res) => {
    console.log(`🎮 CUSTOM Stream request: ${req.params.type}/${req.params.id}`);
    console.log(`🆔 Current userId:`, req.userId || global.currentUserId);
    
    // Předáme request na standardní addon router
    next();
});

// Úvodní stránka s nastavením
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
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; min-height: 100vh; }
        .container { background: white; border-radius: 15px; padding: 40px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
        h1 { color: #4a5568; text-align: center; margin-bottom: 10px; font-size: 2.5em; }
        .subtitle { text-align: center; color: #718096; font-size: 1.2em; margin-bottom: 40px; }
        .setup-section { background: #f7fafc; border: 2px solid #e2e8f0; border-radius: 10px; padding: 30px; margin: 30px 0; }
        .form-group { margin-bottom: 20px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; color: #4a5568; }
        input[type="text"], input[type="password"] { width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px; box-sizing: border-box; }
        input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #667eea; }
        .btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; border: none; border-radius: 25px; font-weight: bold; font-size: 1.1em; cursor: pointer; transition: transform 0.2s; width: 100%; }
        .btn:hover { transform: translateY(-2px); }
        .install-url { background: #2d3748; color: #68d391; padding: 15px; border-radius: 8px; font-family: monospace; word-break: break-all; margin: 20px 0; display: none; }
        .success { background: #c6f6d5; border: 2px solid #68d391; border-radius: 8px; padding: 20px; margin: 20px 0; color: #276749; display: none; }
        .error { background: #fed7d7; border: 2px solid #fc8181; border-radius: 8px; padding: 20px; margin: 20px 0; color: #9b2c2c; display: none; }
        .instructions { background: #e6fffa; border: 2px solid #38b2ac; border-radius: 10px; padding: 20px; margin: 20px 0; }
        .instructions-skt { background: #fef5e7; border: 2px solid #ed8936; border-radius: 10px; padding: 20px; margin: 20px 0; }
        .copy-btn { background: #38a169; color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; margin-left: 10px; }
        .step-number { background: #667eea; color: white; border-radius: 50%; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; margin: 30px 0; }
        .stat-card { background: #f7fafc; border-radius: 10px; padding: 20px; text-align: center; border: 2px solid #e2e8f0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ SKTorrent RealDebrid</h1>
        <p class="subtitle">Nastavení pro přehrávání SKTorrent obsahu přes Real-Debrid</p>

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
                    headers: { 'Content-Type': 'application/json' },
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

// API endpoint pro nastavení
app.post('/setup', async (req, res) => {
    const { rdApiKey, sktUid, sktPass } = req.body;
    
    if (!rdApiKey || rdApiKey.length < 20) {
        return res.status(400).json({ error: 'Neplatný Real-Debrid API klíč' });
    }
    
    if (!sktUid || !sktPass) {
        return res.status(400).json({ error: 'Chybí SKTorrent přihlašovací údaje' });
    }
    
    try {
        // Test Real-Debrid API
        const testResponse = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
            headers: { 'Authorization': `Bearer ${rdApiKey}` },
            timeout: 10000
        });
        
        if (testResponse.status !== 200) {
            return res.status(400).json({ error: 'Real-Debrid API klíč není platný' });
        }
        
        // Test SKTorrent credentials - jednodušší validace
        try {
            const sktTestResponse = await axios.get(BASE_URL, {
                headers: { 
                    Cookie: `uid=${sktUid}; pass=${sktPass}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 15000,
                maxRedirects: 5
            });
            
            console.log(`SKTorrent test status: ${sktTestResponse.status}`);
        } catch (sktError) {
            console.log('SKTorrent test warning:', sktError.message);
            // Nepřerušujeme proces - možná jsou credentials v pořádku
        }
        
        // Vygenerovat user ID
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
        res.status(400).json({ error: 'Nepodařilo se ověřit přihlašovací údaje' });
    }
});

// Manifest endpointy s lepšími headers
app.get('/manifest.json', (req, res) => {
    const manifest = builder.getInterface().manifest;
    
    // Stremio kompatibilní headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    console.log(`📋 Základní manifest požadavek z ${req.ip}`);
    console.log(`📋 User-Agent: ${req.get('User-Agent')}`);
    console.log(`📋 Manifest:`, JSON.stringify(manifest, null, 2));
    
    res.json(manifest);
});

app.get('/manifest/:userId.json', (req, res) => {
    const { userId } = req.params;
    
    console.log(`📋 User manifest požadavek pro: ${userId} z ${req.ip}`);
    console.log(`📋 User-Agent: ${req.get('User-Agent')}`);
    
    if (!users.has(userId)) {
        console.log(`❌ Manifest požadavek pro neexistujícího uživatele: ${userId}`);
        return res.status(404).json({ error: 'Uživatel nenalezen - použijte webové nastavení pro konfiguraci' });
    }
    
    const manifest = builder.getInterface().manifest;
    
    // Přidáme debugging info do manifestu pro development
    if (process.env.NODE_ENV !== 'production') {
        manifest.description += ` [Debug: User ${userId.substring(0,8)}]`;
    }
    
    // Stremio kompatibilní headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(manifest);
});

// Stream endpoint
app.get('/stream/:userId/:infoHash', async (req, res) => {
    const { userId, infoHash } = req.params;
    
    if (!users.has(userId)) {
        return res.status(401).json({ error: 'Neautorizovaný přístup' });
    }
    
    const userConfig = users.get(userId);
    const { rdApiKey } = userConfig;
    const rd = new RealDebridAPI(rdApiKey);
    
    try {
        console.log(`🚀 RealDebrid stream pro: ${infoHash} (user: ${userId})`);
        
        // Cache check
        const cacheKey = `${userId}:${infoHash}`;
        const cached = rdCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() && cached.links) {
            console.log(`🎯 Cache HIT pro ${infoHash}`);
            return res.redirect(302, cached.links[0].url);
        }
        
        // RealDebrid processing
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const rdLinks = await rd.addMagnetIfNotExists(magnetLink, infoHash, 3);
        
        if (rdLinks && rdLinks.length > 0) {
            // Cache with user-specific key
            rdCache.set(cacheKey, {
                timestamp: Date.now(),
                links: rdLinks,
                expiresAt: Date.now() + CACHE_DURATION
            });
            
            console.log(`✅ RD zpracování úspěšné pro ${infoHash} - redirect`);
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

// Cache cleanup
setInterval(() => {
    const now = Date.now();
    
    // Clean expired cache
    for (const [cacheKey, cached] of rdCache.entries()) {
        if (cached.expiresAt <= now) {
            rdCache.delete(cacheKey);
            console.log(`🧹 Vyčištěn cache pro ${cacheKey}`);
        }
    }
    
    // Clean old users (older than 30 days)
    const oldUserLimit = now - (30 * 24 * 60 * 60 * 1000);
    for (const [userId, userData] of users.entries()) {
        if (userData.created < oldUserLimit) {
            users.delete(userId);
            console.log(`🧹 Vyčištěn starý uživatel: ${userId}`);
        }
    }
}, 60000); // Every minute

// Mount addon router LAST (after all custom endpoints)
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Error handling
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

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SKTorrent RealDebrid addon běží na portu ${PORT}`);
    console.log(`🌐 Externí URL: ${addonBaseUrl}`);
    console.log(`💾 Cache: In-memory storage s user-specific keys`);
    console.log(`🎯 Streaming: Přímé redirecty na Real-Debrid`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});