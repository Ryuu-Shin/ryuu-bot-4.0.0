const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const { writeFile, mkdir } = require('fs/promises');
const { exec } = require('child_process');
const path = require('path');
const cron = require('node-cron');

const stickerLimits = new Map(); // Menyimpan batasan pengiriman stiker per pengguna
const STICKER_LIMIT = 5;
const TIME_WINDOW = 60 * 60 * 1000; // 1 jam dalam milidetik
const SPAM_WINDOW = 30 * 1000; // 30 detik dalam milidetik

const DATA_DIR = './data';
const TEXT_DIR = path.join(DATA_DIR, 'text');
const IMAGE_DIR = path.join(DATA_DIR, 'gambar');
const STICKER_DIR = path.join(DATA_DIR, 'sticker');

// Nomor owner (ganti dengan nomor Anda)
const OWNER_NUMBER = '6281234567890@s.whatsapp.net'; // Contoh: 6281234567890

// Pastikan direktori utama ada
[DATA_DIR, TEXT_DIR, IMAGE_DIR, STICKER_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Membersihkan database setiap hari
cron.schedule('0 0 * * *', () => {
    [TEXT_DIR, IMAGE_DIR, STICKER_DIR].forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (!err) {
                files.forEach(file => {
                    const memberDir = path.join(dir, file);
                    if (fs.lstatSync(memberDir).isDirectory()) {
                        fs.readdir(memberDir, (err, files) => {
                            if (!err) {
                                files.forEach(file => fs.unlinkSync(path.join(memberDir, file)));
                            }
                        });
                    }
                });
            }
        });
    });
    console.log('Database dibersihkan!');
});

const commands = {
    help: "Menampilkan daftar perintah",
    halo: "Bot akan membalas dengan pesan sapaan",
    sticker: "Kirim gambar/video untuk dijadikan stiker",
    ping: "Menampilkan latensi bot",
    limit: "Cek sisa limit pengiriman stiker",
    history: "Cek history pesan member (hanya owner)"
};

// Fungsi untuk membuat folder member jika belum ada
function ensureMemberDir(memberId) {
    const memberDirs = [
        path.join(TEXT_DIR, memberId),
        path.join(IMAGE_DIR, memberId),
        path.join(STICKER_DIR, memberId)
    ];
    memberDirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const chatId = msg.key.remoteJid;
            const senderId = msg.key.participant || msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            const memberId = senderId.split('@')[0]; // Ambil ID member tanpa @s.whatsapp.net

            // Buat folder untuk member jika belum ada
            ensureMemberDir(memberId);

            if (text) {
                console.log(`Pesan masuk: ${text}`);
                fs.writeFileSync(`${TEXT_DIR}/${memberId}/${Date.now()}.txt`, `${senderId}: ${text}`);
                
                if (text.toLowerCase() === '.help') {
                    let helpMessage = "*Daftar Perintah:*";
                    for (const [cmd, desc] of Object.entries(commands)) {
                        helpMessage += `\n.${cmd} - ${desc}`;
                    }
                    await sock.sendMessage(chatId, { text: helpMessage });
                    return;
                }
                
                if (text.toLowerCase() === '.ping') {
                    const start = Date.now();
                    await sock.sendMessage(chatId, { text: 'Mengukur latensi...' });
                    const latency = Date.now() - start;
                    await sock.sendMessage(chatId, { text: `Pong! Latensi: ${latency}ms` });
                    return;
                }

                if (text.toLowerCase() === '.limit') {
                    const userStickers = stickerLimits.get(senderId) || [];
                    const now = Date.now();
                    const recentStickers = userStickers.filter(timestamp => now - timestamp < TIME_WINDOW);
                    const remainingLimit = STICKER_LIMIT - recentStickers.length;
                    await sock.sendMessage(chatId, { text: `Sisa limit pengiriman stiker: ${remainingLimit}` });
                    return;
                }

                if (text.toLowerCase().startsWith('.history') && senderId === OWNER_NUMBER) {
                    const mentionedUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!mentionedUser) {
                        await sock.sendMessage(chatId, { text: 'Tag member yang ingin dicek historynya.' });
                        return;
                    }

                    const mentionedMemberId = mentionedUser.split('@')[0];
                    const history = [];
                    const dirs = [TEXT_DIR, IMAGE_DIR, STICKER_DIR];
                    for (const dir of dirs) {
                        const memberDir = path.join(dir, mentionedMemberId);
                        if (fs.existsSync(memberDir)) {
                            const files = fs.readdirSync(memberDir);
                            for (const file of files) {
                                const filePath = path.join(memberDir, file);
                                const content = dir === TEXT_DIR ? fs.readFileSync(filePath, 'utf-8') : `[File: ${path.basename(filePath)}]`;
                                history.push(content);
                            }
                        }
                    }

                    if (history.length === 0) {
                        await sock.sendMessage(chatId, { text: 'Tidak ada history pesan dari member tersebut.' });
                    } else {
                        const historyMessage = `*History pesan dari @${mentionedMemberId}:*\n` + history.join('\n');
                        await sock.sendMessage(chatId, { text: historyMessage, mentions: [mentionedUser] });
                    }
                    return;
                }
            }
            
            if (msg.message.imageMessage || msg.message.videoMessage || msg.message.stickerMessage) {
                const mediaType = msg.message.imageMessage ? 'image' : msg.message.stickerMessage ? 'sticker' : 'video';
                const buffer = await sock.downloadMediaMessage(msg);
                const folder = mediaType === 'image' ? IMAGE_DIR : mediaType === 'sticker' ? STICKER_DIR : IMAGE_DIR;
                const fileName = `${folder}/${memberId}/${Date.now()}.${mediaType === 'image' ? 'jpg' : mediaType === 'sticker' ? 'webp' : 'mp4'}`;
                
                await writeFile(fileName, buffer);
                
                if (mediaType === 'sticker' && chatId.endsWith('@g.us')) { // Hanya berlaku untuk grup
                    const now = Date.now();
                    const userStickers = stickerLimits.get(senderId) || [];
                    const recentStickers = userStickers.filter(timestamp => now - timestamp < TIME_WINDOW);
                    
                    // Cek spam dalam 30 detik
                    const spamStickers = userStickers.filter(timestamp => now - timestamp < SPAM_WINDOW);
                    if (spamStickers.length >= 3) {
                        await sock.sendMessage(chatId, { text: 'Jangan spam sticker woi!' });
                        return;
                    }

                    if (recentStickers.length >= STICKER_LIMIT) {
                        await sock.sendMessage(chatId, { text: 'Anda telah mencapai batas pengiriman stiker (5 stiker per jam).' });
                        return;
                    }
                    
                    recentStickers.push(now);
                    stickerLimits.set(senderId, recentStickers);
                }
                
                if (msg.message.imageMessage || msg.message.videoMessage) {
                    const outputPath = `${STICKER_DIR}/${memberId}/${Date.now()}.webp`;
                    exec(`ffmpeg -i ${fileName} -vf "scale=512:512:force_original_aspect_ratio=decrease" -c:v libwebp -preset default -loop 0 -an -vsync 0 ${outputPath}`, async (error) => {
                        if (!error) {
                            const sticker = fs.readFileSync(outputPath);
                            await sock.sendMessage(chatId, { sticker });
                        }
                    });
                }
            }
        }
    });
}

startBot().catch(console.error);