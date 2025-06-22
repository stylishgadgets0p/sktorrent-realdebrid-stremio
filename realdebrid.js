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

      // Získat seznam aktivních torrentů
      const response = await axios.get(
        `${this.baseURL}/torrents?filter=true&limit=100`,
        { headers: this.headers, timeout: 15000 }
      );

      // Najít torrent podle hash
      const existingTorrent = response.data.find(torrent =>
        torrent.hash && torrent.hash.toLowerCase() === infoHash.toLowerCase()
      );

      if (existingTorrent) {
        console.log(`✅ Torrent již existuje v RD: ${existingTorrent.id} (${existingTorrent.status})`);

        // Pokud je stažený, získat download linky
        if (existingTorrent.status === 'downloaded' && existingTorrent.links) {
          const downloadLinks = await this.getDownloadLinks(existingTorrent.links);
          return {
            exists: true,
            torrentId: existingTorrent.id,
            status: existingTorrent.status,
            links: downloadLinks
          };
        }

        // Pokud se stahuje, vrátit info pro čekání
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
  async addMagnetIfNotExists(magnetLink, infoHash, maxWaitMinutes = 2) {
    if (!this.apiKey) return null;

    try {
      // 1. Nejdřív zkontrolovat existenci
      const existing = await this.checkExistingTorrent(infoHash);

      if (existing.exists) {
        // Torrent už existuje
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

      // 2. Torrent neexistuje - přidat nový
      console.log(`📥 Přidávám nový torrent do RD...`);
      return await this.addMagnetAndWait(magnetLink, maxWaitMinutes);

    } catch (error) {
      console.error(`❌ RD operace selhala: ${error.message}`);
      return null;
    }
  }

  // Čekání na dokončení existujícího torrenta
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

        await new Promise(resolve => setTimeout(resolve, 10000));
      } catch (error) {
        console.log(`❌ Chyba při čekání: ${error.message}`);
        return null;
      }
    }

    console.log(`⏰ Timeout po ${maxWaitMinutes} minutách`);
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
      console.log(`✅ Vybrány všechny soubory`);
    } catch (error) {
      console.log(`❌ Chyba při výběru souborů: ${error.message}`);
    }
  }

  // Přidání nového torrenta
  async addMagnetAndWait(magnetLink, maxWaitMinutes = 2) {
    if (!this.apiKey) return null;

    try {
      console.log(`⏳ Přidávám magnet do RD...`);

      // Přidání magnetu
      const addResponse = await axios.post(
        `${this.baseURL}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnetLink)}`,
        {
          headers: this.headers,
          timeout: 15000
        }
      );

      const torrentId = addResponse.data.id;
      console.log(`📥 Torrent přidán: ${torrentId}`);

      // Vybrat všechny soubory
      await this.selectAllFiles(torrentId);

      // Čekat na dokončení
      return await this.waitForTorrentCompletion(torrentId, maxWaitMinutes);

    } catch (error) {
      console.error(`❌ Přidání magnetu selhalo: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }

  // Získání download linků
  async getDownloadLinks(rdLinks) {
    try {
      const downloadLinks = [];

      for (const link of rdLinks.slice(0, 3)) { // Max 3 soubory
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

      return downloadLinks;

    } catch (error) {
      console.error(`❌ Získání linků selhalo: ${error.response?.status} - ${error.response?.data?.error || error.message}`);
      return null;
    }
  }
}

module.exports = RealDebridAPI;