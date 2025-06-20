const axios = require('axios');

class RealDebridAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.real-debrid.com/rest/1.0';
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
  }

  // Kontrola existujících torrentů v RD
  async checkExistingTorrent(infoHash) {
    if (!this.apiKey) return { exists: false };

    try {
      console.log(`🔍 Kontroluji existující torrenty pro hash: ${infoHash}`);

      const response = await axios.get(
        `${this.baseURL}/torrents?filter=true&limit=100`,
        { headers: this.headers, timeout: 15000 }
      );

      const existingTorrent = response.data.find(torrent =>
        torrent.hash && torrent.hash.toLowerCase() === infoHash.toLowerCase()
      );

      if (existingTorrent) {
        console.log(`✅ Torrent již existuje v RD: ${existingTorrent.id} (${existingTorrent.status})`);

        if (existingTorrent.status === 'downloaded' && existingTorrent.links) {
          const downloadLinks = await this.getDownloadLinks(existingTorrent.links);
          return {
            exists: true,
            torrentId: existingTorrent.id,
            status: existingTorrent.status,
            links: downloadLinks
          };
        }

        return {
          exists: true,
          torrentId: existingTorrent.id,
          status: existingTorrent.status,
          progress: existingTorrent.progress || 0
        };
      }

      console.log(`❌ Torrent neexistuje v RD cache`);
      return { exists: false };

    } catch (error) {
      console.log(`❌ Kontrola existujících torrentů selhala: ${error.response?.status} - ${error.message}`);
      return { exists: false };
    }
  }

  // Inteligentní přidání - pouze pokud neexistuje
  async addMagnetIfNotExists(magnetLink, infoHash, maxWaitMinutes = 3) {
    if (!this.apiKey) return null;

    try {
      // 1. Kontrola existence
      const existing = await this.checkExistingTorrent(infoHash);

      if (existing.exists) {
        if (existing.status === 'downloaded' && existing.links) {
          console.log(`🎯 Používám existující stažený torrent: ${existing.torrentId}`);
          return existing.links;
        }

        if (existing.status === 'downloading') {
          console.log(`⏳ Čekám na dokončení existujícího torrenta: ${existing.torrentId} (${existing.progress}%)`);
          return await this.waitForTorrentCompletion(existing.torrentId, maxWaitMinutes);
        }

        if (existing.status === 'waiting_files_selection') {
          console.log(`🔧 Vybírám soubory pro existující torrent: ${existing.torrentId}`);
          await this.selectAllFiles(existing.torrentId);
          return await this.waitForTorrentCompletion(existing.torrentId, maxWaitMinutes);
        }
      }

      // 2. Přidat nový torrent
      console.log(`📥 Přidávám nový torrent do RD...`);
      return await this.addMagnetAndWait(magnetLink, maxWaitMinutes);

    } catch (error) {
      console.error(`❌ RD operace selhala: ${error.message}`);
      return null;
    }
  }

  // Čekání na dokončení torrenta
  async waitForTorrentCompletion(torrentId, maxWaitMinutes) {
    const maxAttempts = maxWaitMinutes * 6; // 10s intervaly

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const infoResponse = await axios.get(
          `${this.baseURL}/torrents/info/${torrentId}`,
          { headers: this.headers, timeout: 10000 }
        );

        const status = infoResponse.data.status;
        const progress = infoResponse.data.progress || 0;

        console.log(`⏳ RD Progress: ${progress}% (${status}) - ${attempt}/${maxAttempts}`);

        if (status === 'downloaded') {
          console.log(`✅ Torrent dokončen!`);
          return await this.getDownloadLinks(infoResponse.data.links);
        }

        if (status === 'error' || status === 'virus' || status === 'dead') {
          console.log(`❌ Torrent selhal: ${status}`);
          return null;
        }

        // Kratší čekání pro rychlejší odezvu
        await new Promise(resolve => setTimeout(resolve, 10000));
      } catch (error) {
        console.log(`❌ Chyba při čekání na torrent: ${error.message}`);
        return null;
      }
    }

    console.log(`⏰ Timeout při čekání na torrent po ${maxWaitMinutes} minutách`);
    return null;
  }

  // Výběr všech souborů
  async selectAllFiles(torrentId) {
    try {
      await axios.post(
        `${this.baseURL}/torrents/selectFiles/${torrentId}`,
        'files=all',
        { headers: this.headers, timeout: 10000 }
      );
      console.log(`✅ Vybrány všechny soubory pro torrent: ${torrentId}`);
    } catch (error) {
      console.log(`❌ Chyba při výběru souborů: ${error.message}`);
      throw error;
    }
  }

  // Přidání nového torrenta
  async addMagnetAndWait(magnetLink, maxWaitMinutes = 3) {
    if (!this.apiKey) return null;

    try {
      console.log(`⏳ Přidávám magnet do RD...`);

      const addResponse = await axios.post(
        `${this.baseURL}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnetLink)}`,
        {
          headers: this.headers,
          timeout: 15000
        }
      );

      const torrentId = addResponse.data.id;
      console.log(`📥 Torrent přidán do RD: ${torrentId}`);

      // Výběr souborů
      await this.selectAllFiles(torrentId);

      // Čekání na dokončení
      return await this.waitForTorrentCompletion(torrentId, maxWaitMinutes);

    } catch (error) {
      console.error(`❌ RD Add magnet failed: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      
      // Detailnější error handling
      if (error.response?.status === 401) {
        throw new Error('Neplatný Real-Debrid API klíč');
      } else if (error.response?.status === 402) {
        throw new Error('Real-Debrid účet vypršel nebo nemá dostatečný kredit');
      } else if (error.response?.data?.error_code === 9) {
        throw new Error('Torrent není dostupný v Real-Debrid cache');
      }
      
      return null;
    }
  }

  // Získání download linků
  async getDownloadLinks(rdLinks) {
    try {
      const downloadLinks = [];

      // Zpracovat více souborů pro lepší kompatibilitu
      for (const link of rdLinks.slice(0, 5)) {
        const unrestrictResponse = await axios.post(
          `${this.baseURL}/unrestrict/link`,
          `link=${encodeURIComponent(link)}`,
          {
            headers: this.headers,
            timeout: 10000
          }
        );

        downloadLinks.push({
          filename: unrestrictResponse.data.filename,
          url: unrestrictResponse.data.download,
          filesize: unrestrictResponse.data.filesize
        });
      }

      console.log(`✅ Získáno ${downloadLinks.length} download linků`);
      return downloadLinks;

    } catch (error) {
      console.error(`❌ RD Get download links failed: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }

  // Test API klíče
  async testApiKey() {
    try {
      const response = await axios.get(
        `${this.baseURL}/user`,
        { headers: this.headers, timeout: 10000 }
      );
      
      console.log(`✅ Real-Debrid API klíč je platný pro uživatele: ${response.data.username}`);
      return {
        valid: true,
        user: response.data
      };
    } catch (error) {
      console.error(`❌ Real-Debrid API klíč test selhal: ${error.response?.status} - ${error.message}`);
      return {
        valid: false,
        error: error.response?.status === 401 ? 'Neplatný API klíč' : 'Chyba připojení'
      };
    }
  }

  // Získání info o účtu
  async getAccountInfo() {
    try {
      const response = await axios.get(
        `${this.baseURL}/user`,
        { headers: this.headers, timeout: 10000 }
      );
      
      return {
        username: response.data.username,
        email: response.data.email,
        points: response.data.points,
        locale: response.data.locale,
        avatar: response.data.avatar,
        type: response.data.type,
        premium: response.data.premium,
        expiration: response.data.expiration
      };
    } catch (error) {
      console.error(`❌ Získání account info selhalo: ${error.message}`);
      return null;
    }
  }
}

module.exports = RealDebridAPI;