// =================================================================================================
// --- IMPOR LIBRARY (DIPERBAIKI UNTUK COMMONJS) ---
// =================================================================================================

// Import library dengan menggunakan sintaks require() yang benar untuk Node.js
const { Client, LocalAuth, List, Buttons, MessageMedia } = require('whatsapp-web.js');
require('dotenv').config(); // Langsung memanggil config() setelah me-require dotenv
const qrcode = require('qrcode-terminal');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, doc, getDoc, setDoc, getDocs, updateDoc, runTransaction, serverTimestamp, query, where, addDoc, deleteDoc } = require('firebase/firestore');
const { GoogleGenerativeAI } = require('@google/genai');

// =================================================================================================
// --- KONFIGURASI & INISIALISASI ---
// =================================================================================================

const ADMIN_NUMBER = process.env.ADMIN_PHONE_NUMBER.replace('+', '') + '@c.us';
const CATEGORIES = ['Fashion', 'Elektronik', 'Peralatan', 'Mainan', 'Aksesoris', 'Kecantikan', 'Makanan'];

const firebaseConfig = {
    apiKey: process.env.FB_API_KEY,
    authDomain: process.env.FB_AUTH_DOMAIN,
    projectId: process.env.FB_PROJECT_ID,
    storageBucket: process.env.FB_STORAGE_BUCKET,
    messagingSenderId: process.env.FB_MESSAGING_SENDER_ID,
    appId: process.env.FB_APP_ID
};

let db;
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log("🔥 Berhasil terhubung ke Firebase Firestore.");
} catch (error) {
    console.error("❌ Gagal terhubung ke Firebase:", error);
    process.exit(1);
}

// Inisialisasi Gemini AI
let genAI;
let geminiModel;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    console.log("✨ Gemini AI siap digunakan.");
} else {
    console.warn("⚠️ Peringatan: GEMINI_API_KEY tidak ditemukan. Fitur Chatbot AI tidak akan aktif.");
}


// =================================================================================================
// --- STATE & CACHE MANAGEMENT ---
// =================================================================================================

let productsCache = {};
const userState = {}; // Menyimpan state percakapan multi-langkah

// =================================================================================================
// --- FUNGSI HELPER DATABASE ---
// =================================================================================================

async function fetchProductsFromDB() {
    try {
        const productsCol = collection(db, 'products');
        const productSnapshot = await getDocs(productsCol);
        productsCache = {};
        productSnapshot.forEach(doc => {
            productsCache[doc.id] = { id: doc.id, ...doc.data() };
        });
        console.log(`📦 Berhasil memuat ${Object.keys(productsCache).length} produk dari database.`);
    } catch (error) {
        console.error("❌ Gagal mengambil data produk:", error);
    }
}

async function getOrCreateUser(userId) {
    const userRef = doc(db, 'users', userId);
    let userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
        console.log(`👤 Pengguna baru: ${userId}. Membuat profil...`);
        const newUser = {
            createdAt: serverTimestamp(),
            cart: [],
            balance: 0,
            role: 'user',
            lastBonusClaim: null,
            orders: [],
            referralCode: `ALTO${userId.slice(2, 8)}`,
            claimedVouchers: []
        };
        if (userId === ADMIN_NUMBER) {
            newUser.role = 'admin';
            console.log(`👑 Pengguna ${userId} dijadikan sebagai Admin.`);
        }
        await setDoc(userRef, newUser);
        userSnap = await getDoc(userRef);
    }
    
    return { id: userSnap.id, ...userSnap.data() };
}

// =================================================================================================
// --- INISIALISASI KLIEN WHATSAPP ---
// =================================================================================================

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', async () => {
    console.log('✅ Bot Toko Online terhubung!');
    await fetchProductsFromDB();
});

// =================================================================================================
// --- FUNGSI TAMPILAN (UI COMPONENTS) ---
// =================================================================================================

const formatRupiah = (number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(number || 0);

async function sendMainMenu(chatId, userData) {
    const banner = await MessageMedia.fromUrl('https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEjxWXh5i4NUdzFKG8crzDOwi9XazcHTAcsuF_JPtoK34yl5EqDa2gCgY9ySouq6kgf-T3FIl5tkhMVyHL3vS553WrSHwpS9BzEMeYsgvLc3a6sKokeZTKgPHwF5FQ2gKl7PBth4IO38aKbSG8Pd6mbAsQhzK5igZeV9HA3GOHZfw1vW-CcJpYCEOEsCAzo/s2816/Gemini_Generated_Image_24y9jo24y9jo24y9.png');
    await client.sendMessage(chatId, banner, { caption: 'Selamat datang di ALTOSHOP!' });

    const menuRows = [
        { id: 'menu_katalog', title: '🛍️ Katalog Produk' },
        { id: 'menu_keranjang', title: '🛒 Lihat Keranjang' },
        { id: 'menu_bonus', title: '🎁 Halaman Bonus' },
        { id: 'menu_profil', title: '👤 Profil Saya' }
    ];

    if (geminiModel) {
        menuRows.push({ id: 'menu_ai_chat', title: '🤖 Tanya AI' });
    }

    if (userData.role === 'admin') {
        menuRows.push({ id: 'menu_admin', title: '⚙️ Panel Admin' });
    }

    const sections = [{ title: 'Menu Utama', rows: menuRows }];
    const list = new List('Pilih salah satu menu di bawah ini untuk memulai.', 'Buka Menu', sections, 'ALTOSHOP');
    await client.sendMessage(chatId, list);
    delete userState[chatId];
}

async function sendProductList(chatId, category) {
    let productsToShow = Object.values(productsCache).filter(p => p.stock > 0);
    if (category !== 'Semua') {
        productsToShow = productsToShow.filter(p => p.category === category);
    }
    if (productsToShow.length === 0) return client.sendMessage(chatId, 'Maaf, tidak ada produk di kategori ini.');

    await client.sendMessage(chatId, `Menampilkan produk untuk kategori: *${category}*`);
    for (const product of productsToShow) {
        const media = await MessageMedia.fromUrl(product.images[0]);
        const price = product.discountPrice ? `~${formatRupiah(product.price)}~ *${formatRupiah(product.discountPrice)}*` : formatRupiah(product.price);
        const caption = `*${product.name}*\n${price}`;
        const buttons = new Buttons(caption, [{ body: 'Lihat Detail', id: `detail_${product.id}` }], '', '');
        await client.sendMessage(chatId, buttons, { media: media });
    }
}

async function sendProductDetail(chatId, productId) {
    const product = productsCache[productId];
    if (!product) return client.sendMessage(chatId, 'Produk tidak ditemukan.');

    for (const imageUrl of product.images) {
        const media = await MessageMedia.fromUrl(imageUrl);
        await client.sendMessage(chatId, media);
    }

    let detailText = `*${product.name}*\n\n`;
    if (product.discountPrice) {
        detailText += `Harga: ~${formatRupiah(product.price)}~ *${formatRupiah(product.discountPrice)}*\n`;
    } else {
        detailText += `*Harga:* ${formatRupiah(product.price)}\n`;
    }
    detailText += `*Stok:* ${product.stock}\n\n${product.description}`;
    
    if (product.options && product.options.colors && product.options.colors.length > 0) {
        await client.sendMessage(chatId, detailText);
        userState[chatId] = { state: 'SELECT_COLOR', data: { productId: productId, options: {} } };
        const colorRows = product.options.colors.map(color => ({ id: `select_color_${color}`, title: color }));
        const sections = [{ title: 'Pilih Warna', rows: colorRows }];
        const list = new List('Silakan pilih warna yang Anda inginkan.', 'Pilih Warna', sections, 'Opsi Produk');
        await client.sendMessage(chatId, list);
    } else {
        const buttons = new Buttons(detailText, [
            { body: '+ Keranjang 🛒', id: `cart_add_${product.id}` },
            { body: 'Kembali ke Menu ↩️', id: 'back_to_menu' }
        ], 'Detail Produk');
        await client.sendMessage(chatId, buttons);
    }
}

async function sendCartView(chatId, userData) {
    if (!userData.cart || userData.cart.length === 0) {
        return client.sendMessage(chatId, 'Keranjang belanja Anda kosong.');
    }

    let cartText = '🛒 *Isi Keranjang Anda:*\n\n';
    let subtotal = 0;
    userData.cart.forEach((item, index) => {
        const product = productsCache[item.id];
        const price = product.discountPrice || product.price;
        const itemTotal = price * item.quantity;
        subtotal += itemTotal;
        cartText += `${index + 1}. *${product.name}*\n`;
        if (item.options) {
            let variantText = [item.options.color, item.options.size, item.options.sleeve].filter(Boolean).join(' / ');
            cartText += `   - Varian: ${variantText}\n`;
        }
        cartText += `   - Jumlah: ${item.quantity}\n   - Harga: ${formatRupiah(itemTotal)}\n\n`;
    });
    cartText += `*Subtotal:* ${formatRupiah(subtotal)}`;

    const buttons = new Buttons(cartText, [
        { body: 'Checkout Sekarang 💳', id: 'checkout_start' },
        { body: 'Kosongkan Keranjang 🗑️', id: 'cart_clear' }
    ], 'Keranjang Belanja');
    await client.sendMessage(chatId, buttons);
}

// =================================================================================================
// --- EVENT HANDLER UTAMA ---
// =================================================================================================

client.on('message', async message => {
    const chatId = message.from;
    const body = message.body.trim();
    const userData = await getOrCreateUser(chatId);
    const currentState = userState[chatId] || {};

    if (body.toLowerCase() === 'batal' && currentState.state) {
        delete userState[chatId];
        await client.sendMessage(chatId, 'Aksi dibatalkan.');
        return;
    }
    
    if (body.toLowerCase() === '/selesai' && currentState.state === 'AI_CHAT') {
        delete userState[chatId];
        await client.sendMessage(chatId, '🤖 Sesi chat AI selesai. Anda kembali ke menu utama.');
        await sendMainMenu(chatId, userData);
        return;
    }

    // --- 1. Menangani State Percakapan (Guided Flows) ---
    if (currentState.state) {
        if (currentState.state === 'AI_CHAT') {
            try {
                const result = await geminiModel.generateContent(body);
                const response = await result.response;
                const text = response.text();
                await message.reply(text);
            } catch (error) {
                console.error("Error saat menghubungi Gemini:", error);
                await message.reply("Maaf, terjadi kesalahan saat memproses permintaan Anda ke AI.");
            }
            return;
        }
        
        if (currentState.state.startsWith('CHECKOUT_')) {
            switch (currentState.state) {
                case 'CHECKOUT_NAMA':
                    currentState.data.nama = body;
                    currentState.state = 'CHECKOUT_ALAMAT';
                    await client.sendMessage(chatId, `Terima kasih, ${body}.\n\nSekarang, mohon ketik *alamat lengkap* Anda:`);
                    break;
                case 'CHECKOUT_ALAMAT':
                    const userDoc = await getDoc(doc(db, 'users', chatId));
                    currentState.data.alamat = body;
                    currentState.state = 'CHECKOUT_KONFIRMASI';
                    const ongkir = 20000;
                    currentState.data.ongkir = ongkir;
                    let subtotal = 0;
                    userDoc.data().cart.forEach(item => { 
                        const product = productsCache[item.id];
                        const price = product.discountPrice || product.price;
                        subtotal += price * item.quantity;
                    });
                    const total = subtotal + ongkir;
                    currentState.data.total = total;

                    let konfirmasiText = `*Konfirmasi Pesanan Anda:*\n\n*Nama:* ${currentState.data.nama}\n*Alamat:* ${currentState.data.alamat}\n\n*Subtotal:* ${formatRupiah(subtotal)}\n*Ongkir:* ${formatRupiah(ongkir)}\n*Total:* ${formatRupiah(total)}\n\nLakukan pembayaran ke BCA 123456789 a/n ALTOSHOP.`;
                    const buttons = new Buttons(konfirmasiText, [{ body: '✅ Konfirmasi Pesanan', id: 'checkout_confirm' }, { body: '❌ Batal', id: 'checkout_cancel' }], 'Konfirmasi');
                    await client.sendMessage(chatId, buttons);
                    break;
            }
        }
        else if (currentState.state.startsWith('ADMIN_ADD_')) {
            switch (currentState.state) {
                case 'ADMIN_ADD_NAME':
                    currentState.data.name = body;
                    currentState.state = 'ADMIN_ADD_IMAGES';
                    await client.sendMessage(chatId, 'Judul diatur. Sekarang masukkan *link gambar produk* (maksimal 5, pisahkan dengan koma):');
                    break;
                case 'ADMIN_ADD_IMAGES':
                    currentState.data.images = body.split(',').map(url => url.trim());
                    currentState.state = 'ADMIN_ADD_PRICE';
                    await client.sendMessage(chatId, 'Gambar diatur. Sekarang masukkan *harga normal* (hanya angka):');
                    break;
                case 'ADMIN_ADD_PRICE':
                    currentState.data.price = parseInt(body);
                    currentState.state = 'ADMIN_ADD_DISCOUNT_PROMPT';
                    const promptButtons = new Buttons('Harga diatur. Apakah produk ini memiliki *harga diskon*?', [{body: 'Ya, Ada', id:'admin_add_discount_yes'}, {body:'Tidak Ada', id:'admin_add_discount_no'}], 'Harga Diskon');
                    await client.sendMessage(chatId, promptButtons);
                    break;
                case 'ADMIN_ADD_DISCOUNT_PRICE':
                    currentState.data.discountPrice = parseInt(body);
                    currentState.state = 'ADMIN_ADD_STOCK';
                     await client.sendMessage(chatId, 'Harga diskon diatur. Sekarang masukkan *jumlah stok*:');
                    break;
                case 'ADMIN_ADD_STOCK':
                    currentState.data.stock = parseInt(body);
                    currentState.state = 'ADMIN_ADD_DESC';
                    await client.sendMessage(chatId, 'Stok diatur. Sekarang masukkan *deskripsi produk*:');
                    break;
                case 'ADMIN_ADD_DESC':
                    currentState.data.description = body;
                    currentState.state = 'ADMIN_ADD_CONFIRM';
                    let summary = `*Konfirmasi Produk Baru:*\n\n`;
                    summary += `*Kategori:* ${currentState.data.category}\n`;
                    if(currentState.data.options) {
                        if(currentState.data.options.colors) summary += `*Warna:* ${currentState.data.options.colors.join(', ')}\n`;
                        if(currentState.data.options.sizes) summary += `*Ukuran:* ${currentState.data.options.sizes.join(', ')}\n`;
                        if(currentState.data.options.sleeves) summary += `*Lengan:* ${currentState.data.options.sleeves.join(', ')}\n`;
                    }
                    summary += `*Nama:* ${currentState.data.name}\n`;
                    summary += `*Harga:* ${formatRupiah(currentState.data.price)}\n`;
                    if(currentState.data.discountPrice) summary += `*Harga Diskon:* ${formatRupiah(currentState.data.discountPrice)}\n`;
                    summary += `*Stok:* ${currentState.data.stock}\n`;
                    summary += `*Deskripsi:* ${currentState.data.description}\n`;
                    summary += `*Gambar:* ${currentState.data.images.length} link`;
                    const confirmButtons = new Buttons(summary, [{ body: '✅ Simpan Produk', id: 'admin_product_save' }, { body: '❌ Batal', id: 'admin_product_cancel' }], 'Konfirmasi');
                    await client.sendMessage(chatId, confirmButtons);
                    break;
                case 'ADMIN_ADD_FASHION_COLORS':
                    currentState.data.options = { colors: body.split(',').map(s => s.trim()) };
                    currentState.state = 'ADMIN_ADD_FASHION_SIZES';
                    await client.sendMessage(chatId, 'Warna diatur. Sekarang masukkan *ukuran* yang tersedia (pisahkan dengan koma, contoh: S, M, L, XL):');
                    break;
                case 'ADMIN_ADD_FASHION_SIZES':
                    currentState.data.options.sizes = body.split(',').map(s => s.trim());
                    currentState.state = 'ADMIN_ADD_FASHION_SLEEVES';
                    await client.sendMessage(chatId, 'Ukuran diatur. Sekarang masukkan *jenis lengan* yang tersedia (pisahkan dengan koma, contoh: Pendek, Panjang):');
                    break;
                case 'ADMIN_ADD_FASHION_SLEEVES':
                    currentState.data.options.sleeves = body.split(',').map(s => s.trim());
                    currentState.state = 'ADMIN_ADD_NAME';
                    await client.sendMessage(chatId, 'Jenis lengan diatur. Sekarang masukkan *judul produk*:');
                    break;
            }
        }
        return;
    }

    // --- 2. Menangani Pilihan dari Tombol (Buttons) ---
    if (message.type === 'buttons_response') {
        const buttonId = message.selectedButtonId;
        
        if (buttonId === 'cart_add_final') {
            const { productId, options } = currentState.data;
            const userRef = doc(db, 'users', chatId);
            const newCart = [...userData.cart];
            const itemIndex = newCart.findIndex(item => item.id === productId && JSON.stringify(item.options) === JSON.stringify(options));
            if (itemIndex > -1) {
                newCart[itemIndex].quantity++;
            } else {
                newCart.push({ id: productId, quantity: 1, options: options });
            }
            await updateDoc(userRef, { cart: newCart });
            const variantText = [options.color, options.size, options.sleeve].filter(Boolean).join(' / ');
            await client.sendMessage(chatId, `✅ *${productsCache[productId].name}* (Varian: ${variantText}) berhasil ditambahkan ke keranjang!`);
            delete userState[chatId];
            return;
        }
        
        if (buttonId.startsWith('cart_add_') && !buttonId.endsWith('final')) {
            const productId = buttonId.split('_')[2];
            const userRef = doc(db, 'users', chatId);
            const newCart = [...userData.cart];
            const itemIndex = newCart.findIndex(item => item.id === productId && !item.options);
            if (itemIndex > -1) newCart[itemIndex].quantity++; else newCart.push({ id: productId, quantity: 1 });
            await updateDoc(userRef, { cart: newCart });
            await client.sendMessage(chatId, `✅ *${productsCache[productId].name}* ditambahkan ke keranjang!`);
        }
        
        if (buttonId.startsWith('detail_')) await sendProductDetail(chatId, buttonId.split('_')[1]);
        if (buttonId === 'back_to_menu') await sendMainMenu(chatId, userData);
        if (buttonId === 'cart_clear') {
            await updateDoc(doc(db, 'users', chatId), { cart: [] });
            await client.sendMessage(chatId, '🗑️ Keranjang belanja Anda telah dikosongkan.');
        }
        if (buttonId === 'checkout_start') await startCheckout(chatId, userData);
        if (buttonId === 'checkout_cancel' || buttonId === 'admin_product_cancel') {
            delete userState[chatId];
            await client.sendMessage(chatId, 'Aksi dibatalkan.');
        }
        if (buttonId === 'checkout_confirm') {
            const orderData = {
                userId: chatId, items: userData.cart, shippingInfo: userState[chatId].data,
                total: userState[chatId].data.total, status: 'Pending', createdAt: serverTimestamp()
            };
            await addDoc(collection(db, 'orders'), orderData);
            await updateDoc(doc(db, 'users', chatId), { cart: [] });
            delete userState[chatId];
            await client.sendMessage(chatId, '🎉 Pesanan Anda berhasil dibuat! Terima kasih.');
        }
        if (buttonId === 'admin_add_discount_yes') { userState[chatId].state = 'ADMIN_ADD_DISCOUNT_PRICE'; await client.sendMessage(chatId, 'Baik. Masukkan *harga diskon* (hanya angka):'); }
        if (buttonId === 'admin_add_discount_no') { userState[chatId].state = 'ADMIN_ADD_STOCK'; await client.sendMessage(chatId, 'OK. Sekarang masukkan *jumlah stok*:'); }
        if (buttonId === 'admin_product_save') {
            const newProduct = userState[chatId].data;
            await addDoc(collection(db, 'products'), newProduct);
            await fetchProductsFromDB();
            delete userState[chatId];
            await client.sendMessage(chatId, '✅ Produk baru berhasil disimpan ke database!');
        }
        return;
    }

    // --- 3. Menangani Pilihan dari Daftar (List) ---
    if (message.selectedRowId) {
        const menuId = message.selectedRowId;
        
        if (menuId.startsWith('select_color_')) {
            const color = menuId.split('_')[2];
            currentState.data.options.color = color;
            const product = productsCache[currentState.data.productId];
            
            if (product.options.sizes && product.options.sizes.length > 0) {
                currentState.state = 'SELECT_SIZE';
                const sizeRows = product.options.sizes.map(size => ({ id: `select_size_${size}`, title: size }));
                const sections = [{ title: 'Pilih Ukuran', rows: sizeRows }];
                const list = new List(`Warna *${color}* dipilih. Sekarang, silakan pilih ukuran.`, 'Pilih Ukuran', sections, 'Opsi Produk');
                await client.sendMessage(chatId, list);
            } else {
                const buttons = new Buttons(`Anda memilih *${product.name}* (Warna: ${color}).`, [{ body: '+ Keranjang 🛒', id: `cart_add_final` }], 'Konfirmasi');
                await client.sendMessage(chatId, buttons);
            }
            return;
        }
        if (menuId.startsWith('select_size_')) {
            const size = menuId.split('_')[2];
            currentState.data.options.size = size;
            const product = productsCache[currentState.data.productId];

            if (product.options.sleeves && product.options.sleeves.length > 0) {
                currentState.state = 'SELECT_SLEEVE';
                const sleeveRows = product.options.sleeves.map(sleeve => ({ id: `select_sleeve_${sleeve}`, title: sleeve }));
                const sections = [{ title: 'Pilih Jenis Lengan', rows: sleeveRows }];
                const list = new List(`Ukuran *${size}* dipilih. Sekarang, pilih jenis lengan.`, 'Pilih Lengan', sections, 'Opsi Produk');
                await client.sendMessage(chatId, list);
            } else {
                const buttons = new Buttons(`Anda memilih *${product.name}* (Warna: ${currentState.data.options.color}, Ukuran: ${size}).`, [{ body: '+ Keranjang 🛒', id: `cart_add_final` }], 'Konfirmasi');
                await client.sendMessage(chatId, buttons);
            }
            return;
        }
        if (menuId.startsWith('select_sleeve_')) {
            const sleeve = menuId.split('_')[2];
            currentState.data.options.sleeve = sleeve;
            const product = productsCache[currentState.data.productId];
            const variantText = [currentState.data.options.color, currentState.data.options.size, sleeve].filter(Boolean).join(' / ');
            const buttons = new Buttons(`Anda memilih *${product.name}* (${variantText}).`, [{ body: '+ Keranjang 🛒', id: `cart_add_final` }], 'Konfirmasi');
            await client.sendMessage(chatId, buttons);
            return;
        }
        
        if (menuId.startsWith('admin_cat_')) {
            const category = menuId.split('_')[2];
            userState[chatId] = { state: '', data: { category: category } };
            if (category === 'Fashion') {
                userState[chatId].state = 'ADMIN_ADD_FASHION_COLORS';
                await client.sendMessage(chatId, `Kategori diatur ke *Fashion*. Sekarang masukkan *warna* yang tersedia (pisahkan dengan koma, contoh: Merah, Biru, Hitam):`);
            } else {
                userState[chatId].state = 'ADMIN_ADD_NAME';
                await client.sendMessage(chatId, `Kategori diatur ke *${category}*. Sekarang masukkan *judul produk*:`);
            }
            return;
        }
        
        if (menuId.startsWith('cat_')) await sendProductList(chatId, menuId.split('_')[1]);
        else if (menuId === 'menu_katalog') {
            const categoryEmojis = { 'Fashion': '👕', 'Elektronik': '📱', 'Peralatan': '🛠️', 'Mainan': '🧸', 'Aksesoris': '⌚', 'Kecantikan': '💄', 'Makanan': '🍔' };
            const categoryRows = CATEGORIES.map(cat => ({ id: `cat_${cat}`, title: `${categoryEmojis[cat] || '🛍️'} ${cat}` }));
            categoryRows.unshift({ id: 'cat_Semua', title: '✨ Semua Produk' });
            const sections = [{ title: 'Pilih Kategori', rows: categoryRows }];
            await client.sendMessage(chatId, new List('Silakan pilih kategori.', 'Pilih Kategori', sections, 'Katalog'));
        }
        else if (menuId === 'menu_keranjang') await sendCartView(chatId, userData);
        else if (menuId === 'menu_bonus') {
            const bonusText = `🎁 *Halaman Bonus*\n\nSaldo Anda: *${formatRupiah(userData.balance)}*\n\nKetik */klaim* untuk bonus harian.\nKetik */voucher [kode]* untuk redeem voucher.`;
            await client.sendMessage(chatId, bonusText);
        }
        else if (menuId === 'menu_profil') {
            const profileText = `👤 *Profil Anda*\n\n*Nomor:* ${chatId.split('@')[0]}\n*Bergabung:* ${userData.createdAt.toDate().toLocaleDateString('id-ID')}\n*Kode Referral:* ${userData.referralCode}`;
            await client.sendMessage(chatId, profileText);
        }
        else if (menuId === 'menu_ai_chat') {
            if (!geminiModel) return client.sendMessage(chatId, "Maaf, fitur AI sedang tidak tersedia.");
            userState[chatId] = { state: 'AI_CHAT' };
            await client.sendMessage(chatId, "Anda sekarang terhubung dengan Asisten AI. Silakan ajukan pertanyaan Anda.\n\nKetik */selesai* untuk kembali ke menu utama.");
        }
        else if (menuId === 'menu_admin') {
            const adminText = `⚙️ *Panel Admin*\n\nBerikut perintah yang tersedia:\n\n*/admin tambahproduk*\n*/admin reloadproduk*\n*/admin lihatpesanan*\n*/admin kirimpesan [pesan]*`;
            await client.sendMessage(chatId, adminText);
        }
        return;
    }
    
    // --- 4. Menangani Perintah Teks (Bonus & Admin) ---
    if (body.startsWith('/')) {
        const args = body.split(' ');
        const command = args[0].toLowerCase();
        
        if (command === '/klaim') {
            const today = new Date().toDateString();
            const lastClaim = userData.lastBonusClaim ? userData.lastBonusClaim.toDate().toDateString() : null;
            if (lastClaim === today) return client.sendMessage(chatId, 'Maaf, Anda sudah mengklaim bonus harian hari ini.');
            
            const bonusAmount = Math.floor(Math.random() * 5000) + 1000;
            await updateDoc(doc(db, 'users', chatId), {
                balance: (userData.balance || 0) + bonusAmount,
                lastBonusClaim: serverTimestamp()
            });
            await client.sendMessage(chatId, `🎉 Selamat! Anda mendapatkan bonus harian sebesar *${formatRupiah(bonusAmount)}*!`);
            return;
        }
        if (command === '/voucher') {
            const code = args[1];
            if (!code) return client.sendMessage(chatId, 'Gunakan format: /voucher [kode]');
            
            const q = query(collection(db, 'vouchers'), where('code', '==', code.toUpperCase()));
            const voucherSnap = await getDocs(q);
            if (voucherSnap.empty) return client.sendMessage(chatId, '❌ Kode voucher tidak valid.');
            
            const voucherDoc = voucherSnap.docs[0];
            const voucherData = voucherDoc.data();
            if (voucherData.quantity <= 0) return client.sendMessage(chatId, '❌ Maaf, voucher ini sudah habis.');
            if (userData.claimedVouchers && userData.claimedVouchers.includes(code.toUpperCase())) return client.sendMessage(chatId, '❌ Anda sudah pernah menggunakan voucher ini.');

            await runTransaction(db, async (t) => {
                t.update(doc(db, 'users', chatId), {
                    balance: (userData.balance || 0) + voucherData.amount,
                    claimedVouchers: [...(userData.claimedVouchers || []), code.toUpperCase()]
                });
                t.update(doc(db, 'vouchers', voucherDoc.id), { quantity: voucherData.quantity - 1 });
            });
            await client.sendMessage(chatId, `✅ Voucher berhasil digunakan! Saldo Anda bertambah *${formatRupiah(voucherData.amount)}*.`);
            return;
        }

        if (command === '/admin' && userData.role === 'admin') {
            const subCommand = args[1];
            if (subCommand === 'tambahproduk') {
                const rows = CATEGORIES.map(cat => ({ id: `admin_cat_${cat}`, title: cat }));
                const sections = [{ title: 'Pilih Kategori Produk', rows: rows }];
                const list = new List('Langkah 1: Pilih kategori untuk produk baru.', 'Pilih Kategori', sections, 'Tambah Produk');
                await client.sendMessage(chatId, list);
            } else if (subCommand === 'reloadproduk') {
                await fetchProductsFromDB();
                await client.sendMessage(chatId, '✅ Cache produk berhasil dimuat ulang.');
            } else if (subCommand === 'lihatpesanan') {
                const ordersQuery = query(collection(db, 'orders'));
                const ordersSnap = await getDocs(ordersQuery);
                let ordersText = '*5 Pesanan Terakhir:*\n\n';
                ordersSnap.docs.slice(0, 5).forEach(d => {
                    const order = d.data();
                    ordersText += `*ID:* ${d.id.slice(0, 5)}...\n*User:* ${order.userId.split('@')[0]}\n*Total:* ${formatRupiah(order.total)}\n*Status:* ${order.status}\n---\n`;
                });
                await client.sendMessage(chatId, ordersText);
            } else if (subCommand === 'kirimpesan') {
                const messageToSend = args.slice(2).join(' ');
                if (!messageToSend) return client.sendMessage(chatId, 'Gunakan format: /admin kirimpesan [pesan]');
                const usersSnap = await getDocs(collection(db, 'users'));
                client.sendMessage(chatId, `Mengirim pesan ke ${usersSnap.size} pengguna...`);
                usersSnap.forEach(userDoc => client.sendMessage(userDoc.id, `*Pesan dari Admin:*\n${messageToSend}`));
            } else {
                await client.sendMessage(chatId, 'Perintah admin tidak valid. Coba: tambahproduk, reloadproduk, lihatpesanan, kirimpesan');
            }
            return;
        }
    }

    // --- 5. Jika tidak ada yang cocok, kirim menu utama ---
    if (!currentState.state) {
        await sendMainMenu(chatId, userData);
    }
});

client.initialize();
