// ============================================
//  КОНФИГУРАЦИЯ
// ============================================
const CONFIG = {
    // ============================================================
    // GEMINI API
    // ВСТАВЬ СЮДА СВОЙ КЛЮЧ ИЗ GOOGLE AI STUDIO.
    // ============================================================
    GEMINI_API_KEY: 'AQ.Ab8RN6LjrrjId-nJVX07_Z6o1bJ507QW6zQp3OH8Kjgp948FUA',
    // Основная модель + резервные Flash-модели. Если Google временно перегружен,
    // приложение автоматически попробует следующую.
    MODELS: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
    DEFAULT_SETTINGS: { appliances: ['индукционная плита', 'микроволновка', 'чайник'] },
    EXPIRY_DAYS: {
        milk: 7, yogurt: 10, cheese: 14, meat: 3, fish: 2,
        vegetables: 7, fruits: 5, eggs: 20, bread: 4, custom: 5,
        cereals: 180, spices: 365
    },
    FREEZER_EXPIRY_MULTIPLIER: 3,
    ENERGY: {
        'индукционная плита': 1.8, 'газовая плита': 0.3, 'электроплита': 2.5,
        'печь(газ)': 0.35, 'печь(электро)': 2.8, духовка: 3.0,
        микроволновка: 1.2, чайник: 2.0, мультиварка: 1.0,
        вафельница: 0.8, миксер: 0.3, блендер: 0.3, тостер: 0.8,
        электрогриль: 2.0, пароварка: 1.5
    }
};

// ============================================
//  БАЗА ДАННЫХ
// ============================================
const db = new Dexie('EnergyKitchenDB');
db.version(8).stores({
    chats: '++id, title, type, createdAt, updatedAt',
    messages: '++id, chatId, role, content, timestamp, favorite',
    settings: 'key',
    products: '++id, name, category, purchaseDate, expiryDays, storage, opened, weight, customName',
    energyLog: '++id, date, hour, consumption, baseCost, currency, mode, recipeName',
    favorites: '++id, messageId, chatId, content, recipeTitle, timestamp, baseCost'
});

// ============================================
//  ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================================
let currentChatId = null;
let products = [];
let settings = { ...CONFIG.DEFAULT_SETTINGS };
let isLoading = false;
let currentTab = 'fridge';
let pendingDeleteChatId = null;
let confirmCallback = null;
let profileName = localStorage.getItem('profileName') || 'Пользователь';
let profileAvatar = localStorage.getItem('profileAvatar') || '👤';
let profileAvatarColor = localStorage.getItem('profileAvatarColor') || '#e6f0e3';
let userCountry = localStorage.getItem('userCountry') || 'Беларусь';
let userCurrency = localStorage.getItem('userCurrency') || 'BYN';
let exchangeRates = JSON.parse(localStorage.getItem('exchangeRates') || '{}');
let lastRateUpdate = localStorage.getItem('lastRateUpdate') || '';
let userHealthProfile = { allergies: '', diet: '', restrictions: '' };
let userTasteProfile = {
    likedCuisines: [], likedIngredients: [], dislikedIngredients: [],
    sweetTooth: false, salty: false, bitter: false, sour: false,
    fastFood: [], cuisineNotes: '', ingredientsNotes: ''
};
let energyHistory = [];
let hourlyChart, dailyChart, forecastChart;
let lastForecastHash = null;

// ============================================
//  УТИЛИТЫ
// ============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.innerHTML = `<i>${icons[type] || 'ℹ️'}</i><span class="toast-message">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function formatMessage(text) {
    return text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

function calculateExpiry(purchaseDate, expiryDays, storage = 'fridge', opened = false) {
    let days = expiryDays;
    
    // Морозилка увеличивает срок хранения (умножаем на коэффициент)
    if (storage === 'freezer') {
        days = Math.round(expiryDays * CONFIG.FREEZER_EXPIRY_MULTIPLIER); // ×3
    }
    
    // Вскрытая упаковка сокращает срок только для холодильника и шкафчика
    if (opened && storage !== 'freezer') {
        days = Math.max(1, Math.floor(days * 0.5)); // но не меньше 1 дня
    }
    
    // Для морозилки вскрытие не так критично – слегка уменьшаем
    if (opened && storage === 'freezer') {
        days = Math.max(1, Math.floor(days * 0.8)); // сохраняем 80% срока
    }
    
    const expiry = new Date(purchaseDate);
    expiry.setDate(expiry.getDate() + days);
    return expiry;
}

function getDaysLeft(expiryDate) {
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.ceil((expiryDate - today) / (1000*60*60*24));
}

function correctProductName(input) {
    const corrections = { 'фасоль': 'Фасоль', 'яблоко': 'Яблоко', 'молоко': 'Молоко', 'хлеб': 'Хлеб', 'яйца': 'Яйца' };
    const lower = input.toLowerCase().trim();
    return corrections[lower] || input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
}

function showConfirmModal(title, message, onConfirm, confirmLabel = 'Подтвердить') {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    const okBtn = document.getElementById('confirmOkBtn');
    if (okBtn) okBtn.textContent = confirmLabel;
    confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.add('show');
}

function hideConfirmModal() {
    document.getElementById('confirmModal').classList.remove('show');
    confirmCallback = null;
}

function getFlagEmoji(country) {
    const flags = { 'Беларусь': '🇧🇾', 'Россия': '🇷🇺', 'Казахстан': '🇰🇿', 'Украина': '🇺🇦', 'США': '🇺🇸', 'Германия': '🇩🇪', 'Франция': '🇫🇷' };
    return flags[country] || '🌍';
}

async function callAI(prompt) {
    const apiKey = String(CONFIG.GEMINI_API_KEY || '').trim();

    if (!apiKey || apiKey === 'ВСТАВЬ_СЮДА_СВОЙ_GEMINI_API_KEY') {
        return '❌ Gemini не настроен. Откройте js/app.js и вставьте API-ключ в CONFIG.GEMINI_API_KEY.';
    }

    // ВАЖНО: ключи AQ. — это новый тип authorization key. Google переводит
    // AI Studio на них с 28.05.2026, но сейчас встречаются случаи, когда
    // Generative Language API возвращает 401 ACCESS_TOKEN_TYPE_UNSUPPORTED.
    // Это проблема авторизации ключа/проекта, а не выбора модели.
    const models = Array.isArray(CONFIG.MODELS) && CONFIG.MODELS.length
        ? CONFIG.MODELS
        : ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];

    const systemText =
        'Ты — кулинарный ассистент приложения «ЭнергоКухня». ' +
        'Предлагай практичные и подробные рецепты с ингредиентами, ' +
        'граммовками, примерным временем и пошаговыми инструкциями. ' +
        'Учитывай продукты пользователя, его ограничения и бытовую ситуацию. ' +
        'Отвечай на русском языке. Не выдумывай наличие продукта, если оно не указано.';

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const diagnostics = [];

    for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': apiKey
                        },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: systemText }] },
                            contents: [{ role: 'user', parts: [{ text: String(prompt) }] }],
                            generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
                        })
                    }
                );

                let data = null;
                try { data = await response.json(); } catch (_) {}
                const apiMessage = data?.error?.message || `HTTP ${response.status}`;
                const apiReason = data?.error?.details?.find(d => d?.reason)?.reason || '';

                if (response.ok) {
                    const parts = data?.candidates?.[0]?.content?.parts || [];
                    const content = parts.map(part => part?.text || '').join('').trim();
                    if (content) return content;
                    diagnostics.push(`${model}: пустой ответ (${data?.candidates?.[0]?.finishReason || 'UNKNOWN'})`);
                    break;
                }

                console.error(`Gemini API error (${model}):`, response.status, data);

                // Авторизация относится ко всему ключу, поэтому смена модели здесь не поможет.
                if (response.status === 401) {
                    const isAQAuthIssue = apiReason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED' ||
                        /Expected OAuth 2 access token|invalid authentication credentials/i.test(apiMessage);
                    if (isAQAuthIssue && apiKey.startsWith('AQ.')) {
                        return '❌ Gemini не принимает этот AQ.-ключ.\n\n' +
                            'Google сейчас переводит AI Studio на новый тип ключей, и для части новых AQ.-ключей ' +
                            'Generative Language API возвращает ACCESS_TOKEN_TYPE_UNSUPPORTED.\n\n' +
                            'Это не ошибка GitHub, модели или сайта. Создайте/выберите рабочий Gemini API key в Google AI Studio ' +
                            'и вставьте его в CONFIG.GEMINI_API_KEY.\n\n' +
                            `HTTP: 401\nПричина: ${apiMessage}`;
                    }
                    return `❌ Gemini: ключ не принят.\n\nHTTP: 401\nПричина: ${apiMessage}`;
                }

                if (response.status === 403) {
                    return `❌ Gemini: доступ запрещён для этого ключа/проекта.\n\nHTTP: 403\nПричина: ${apiMessage}`;
                }

                diagnostics.push(`${model}: HTTP ${response.status} — ${apiMessage}`);

                // Модель не найдена/недоступна — сразу следующая.
                if (response.status === 404) break;

                // Квота/временная ошибка — одна повторная попытка, затем следующая модель.
                if ([429, 500, 503].includes(response.status)) {
                    if (attempt === 0) {
                        await sleep(response.status === 429 ? 1800 : 1200);
                        continue;
                    }
                }
                break;
            } catch (error) {
                diagnostics.push(`${model}: сеть — ${error?.message || 'ошибка сети'}`);
                console.error(`Gemini network error (${model}):`, error);
                if (attempt === 0) {
                    await sleep(900);
                    continue;
                }
                break;
            }
        }
    }

    return '❌ Gemini сейчас не отвечает.\n\nПроверены модели:\n' +
        diagnostics.map(x => '• ' + x).join('\n') +
        '\n\n429 — временная/квотная проблема; 404 — модель недоступна; 500/503 — временная ошибка сервиса.';
}

async function testGeminiConnection() {
    const apiKey = String(CONFIG.GEMINI_API_KEY || '').trim();
    if (!apiKey || apiKey === 'ВСТАВЬ_СЮДА_СВОЙ_GEMINI_API_KEY') {
        return { ok: false, message: 'Ключ не указан в CONFIG.GEMINI_API_KEY.' };
    }

    const model = CONFIG.MODELS?.[0] || 'gemini-3.5-flash-lite';
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Ответь одним словом: OK' }] }] })
            }
        );
        const data = await response.json().catch(() => ({}));
        if (response.ok) return { ok: true, message: `Gemini подключён (${model}).` };
        const reason = data?.error?.details?.find(d => d?.reason)?.reason || '';
        return { ok: false, status: response.status, reason, message: data?.error?.message || 'Неизвестная ошибка API.' };
    } catch (e) {
        return { ok: false, message: e?.message || 'Ошибка сети.' };
    }
}

function clearAIKey() {
    showToast('API-ключ хранится в js/app.js. Чтобы заменить его, измените CONFIG.GEMINI_API_KEY.', 'info');
}

function getExchangeRateSync(baseCurrency, targetCurrency) {
    if (baseCurrency === targetCurrency) return 1;
    if (exchangeRates[targetCurrency] && lastRateUpdate) {
        return exchangeRates[targetCurrency];
    }
    return 1;
}

// ============================================
//  ЗАГРУЗКА ДАННЫХ
// ============================================
async function loadData() {
    try {
        const savedSettings = await db.settings.get('appSettings');
        if (savedSettings) settings = savedSettings.value;
        else await db.settings.put({ key: 'appSettings', value: settings });
        products = await db.products.toArray();
        const chats = await db.chats.toArray();
        if (chats.length === 0) {
            currentChatId = await db.chats.add({ title: 'Новый чат', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
        } else {
            const lastId = localStorage.getItem('lastChatId');
            currentChatId = (lastId && chats.find(c => c.id == lastId)) ? Number(lastId) : chats[0].id;
        }
        const savedEnergy = localStorage.getItem('energyHistory');
        if (savedEnergy) energyHistory = JSON.parse(savedEnergy);
        const savedHealth = localStorage.getItem('userHealthProfile');
        if (savedHealth) userHealthProfile = JSON.parse(savedHealth);
        const savedTaste = localStorage.getItem('userTasteProfile');
        if (savedTaste) userTasteProfile = JSON.parse(savedTaste);
        await renderAll();
        updateThemeIcon();
        applySettingsToForm();
        updateProfileUI();
        updateRecommendationBadge();
    } catch (e) {
        console.error('Ошибка загрузки:', e);
    }
}

function applySettingsToForm() {
    document.querySelectorAll('.appliance-check').forEach(cb => {
        cb.checked = settings.appliances.includes(cb.value);
    });
}

function updateProfileUI() {
    const avatarEl = document.getElementById('profileAvatar');
    if (avatarEl) {
        avatarEl.innerHTML = `<span style="font-size:60px;">${profileAvatar}</span>`;
        avatarEl.style.background = profileAvatarColor;
    }
    document.getElementById('profileNameDisplay').textContent = profileName;
    document.getElementById('profileNameInput').value = profileName;
    const headerBtn = document.getElementById('profileBtn');
    if (headerBtn) headerBtn.innerHTML = profileAvatar;
    const countryBtn = document.getElementById('selectCountryBtn');
    if (countryBtn) countryBtn.innerHTML = `${getFlagEmoji(userCountry)} ${userCountry}`;
    const currencyBtn = document.getElementById('selectCurrencyBtn');
    if (currencyBtn) currencyBtn.innerHTML = `💵 ${userCurrency}`;
}

function updateThemeIcon() {
    const theme = localStorage.getItem('theme') || 'light';
    const icon = document.querySelector('#themeToggle i');
    if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', newTheme);
    updateThemeIcon();
}

function updateRecommendationBadge() {
    const urgent = products.filter(p => {
        const exp = calculateExpiry(p.purchaseDate, p.expiryDays, p.storage, p.opened);
        const days = getDaysLeft(exp);
        return days <= 3;
    });
    const badge = document.getElementById('recommendationBadge');
    const btn = document.getElementById('recommendationsBtn');
    if (urgent.length > 0) {
        badge.classList.remove('hidden');
        btn.classList.add('has-urgent');
    } else {
        badge.classList.add('hidden');
        btn.classList.remove('has-urgent');
    }
}

// ============================================
//  РЕНДЕРИНГ ЧАТА
// ============================================
async function renderAll() {
    await renderChatList();
    await renderMessages();
    updateChatTitle();
    updateRecommendationBadge();
}

async function renderChatList() {
    const chats = await db.chats.toArray();
    const list = document.getElementById('chatList');
    if (!list) return;
    list.innerHTML = '';
    chats.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)).forEach(chat => {
        const li = document.createElement('li');
        li.className = `chat-item ${chat.id === currentChatId ? 'active' : ''}`;
        li.innerHTML = `
            <span class="chat-title"><i class="fas fa-utensils"></i> ${chat.title || 'Без названия'}</span>
            <button class="delete-chat" data-id="${chat.id}"><i class="fas fa-trash-alt"></i></button>
        `;
        li.addEventListener('click', (e) => {
            if (!e.target.closest('.delete-chat')) switchChat(chat.id);
        });
        li.querySelector('.delete-chat').addEventListener('click', (e) => {
            e.stopPropagation();
            pendingDeleteChatId = chat.id;
            showConfirmModal('Удалить чат?', 'Все сообщения будут потеряны.', async () => {
                await deleteChat(pendingDeleteChatId);
                hideConfirmModal();
            });
        });
        list.appendChild(li);
    });
}

async function renderMessages() {
    const container = document.getElementById('chatMessages');
    if (!currentChatId) {
        showWelcomeMessage(container);
        return;
    }
    const messages = await db.messages.where('chatId').equals(currentChatId).sortBy('timestamp');
    if (messages.length === 0) {
        showWelcomeMessage(container);
        return;
    }
    const existingWelcome = container.querySelector('.welcome-message');
    if (existingWelcome) {
        existingWelcome.classList.add('fade-out-up');
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    container.innerHTML = '';
    messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `message ${msg.role}`;
        let content = formatMessage(msg.content);
        if (msg.role === 'bot' && !msg.content.startsWith('⏳')) {
            content += `
                <div class="message-actions">
                    <button class="btn btn-sm btn-secondary favorite-recipe-btn" data-message-id="${msg.id}">
                        <i class="fas fa-star"></i> В избранное
                    </button>
                    <button class="btn btn-sm btn-primary cooked-btn" data-recipe-id="${msg.id}">
                        <i class="fas fa-check"></i> Приготовил
                    </button>
                </div>`;
        }
        div.innerHTML = `<div class="message-content">${content}</div>`;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
    attachMessageActionHandlers();
}

function showWelcomeMessage(container) {
    container.innerHTML = `
        <div class="welcome-message">
            <div style="text-align: center; max-width: 400px;">
                <div style="font-style: italic; margin-bottom: 12px; font-size: 1.2rem;">🌿 Привет! Я — ЭнергоКухня.</div>
                <div>Моя задача — помочь тебе разумно управлять продуктами и электроэнергией на кухне.</div>
            </div>
        </div>`;
}

function attachMessageActionHandlers() {
    document.querySelectorAll('.favorite-recipe-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const messageId = Number(btn.dataset.messageId);
            const msg = await db.messages.get(messageId);
            if (!msg) return;
            const isFav = await db.favorites.where('messageId').equals(messageId).count();
            if (isFav > 0) {
                await db.favorites.where('messageId').equals(messageId).delete();
                await db.messages.update(messageId, { favorite: false });
                btn.innerHTML = '<i class="fas fa-star"></i> В избранное';
                showToast('Удалено из избранного', 'info');
            } else {
                const cleanContent = msg.content.replace(/\*\*(.*?)\*\*/g, '$1').replace(/<[^>]+>/g, '');
                const title = cleanContent.slice(0, 40) + (cleanContent.length > 40 ? '…' : '');
                const costMatch = cleanContent.match(/Стоимость:\s*(\d+(?:\.\d+)?)\s*(\w+)/);
                let baseCost = 0;
                if (costMatch) {
                    const amount = parseFloat(costMatch[1]);
                    const currency = costMatch[2];
                    const rate = await getExchangeRate(currency, 'BYN');
                    baseCost = amount * rate;
                }
                await db.favorites.add({
                    messageId,
                    chatId: msg.chatId,
                    content: cleanContent,
                    recipeTitle: title,
                    baseCost,
                    timestamp: new Date()
                });
                await db.messages.update(messageId, { favorite: true });
                btn.innerHTML = '<i class="fas fa-star" style="color:gold;"></i> В избранном';
                showToast('Добавлено в избранное', 'success');
            }
        });
    });
    document.querySelectorAll('.cooked-btn').forEach(btn => {
        btn.addEventListener('click', () => markAsCooked(Number(btn.dataset.recipeId)));
    });
}

// ============================================
//  ФИНАНСЫ И ЭНЕРГИЯ
// ============================================
async function getExchangeRate(baseCurrency, targetCurrency) {
    if (baseCurrency === targetCurrency) return 1;
    const now = Date.now();
    if (exchangeRates[targetCurrency] && lastRateUpdate && (now - parseInt(lastRateUpdate)) < 3600000) {
        return exchangeRates[targetCurrency];
    }
    const prompt = `Курс ${baseCurrency} к ${targetCurrency} на сегодня. Только число.`;
    const rate = parseFloat(await callAI(prompt));
    if (!isNaN(rate) && rate > 0) {
        exchangeRates[targetCurrency] = rate;
        localStorage.setItem('exchangeRates', JSON.stringify(exchangeRates));
        localStorage.setItem('lastRateUpdate', now.toString());
        return rate;
    }
    return 1;
}

async function markAsCooked(messageId) {
    const msg = await db.messages.get(messageId);
    if (!msg) return;
    const content = msg.content;

    const energyMatch = content.match(/(\d+(?:\.\d+)?)\s*кВт·ч/);
    const consumption = energyMatch ? parseFloat(energyMatch[1]) : 0.5;

    const costMatch = content.match(/Стоимость электроэнергии:\s*(\d+(?:\.\d+)?)\s*(\w+)/);
    let baseCost = 0.20 * consumption; // fallback с актуальным тарифом
    if (costMatch) {
        const amount = parseFloat(costMatch[1]);
        const currency = costMatch[2];
        const rate = await getExchangeRate(currency, 'BYN');
        baseCost = amount * rate;
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const mode = document.getElementById('cookingModeSelect')?.value || 'normal';

    await db.energyLog.add({
        date, hour, consumption, baseCost, currency: userCurrency, mode,
        recipeName: content.slice(0, 50)
    });

    let existing = energyHistory.find(e => e.date === date);
    if (!existing) {
        existing = { date, consumption: 0, baseCost: 0 };
        energyHistory.push(existing);
    }
    existing.consumption += consumption;
    existing.baseCost += baseCost;
    localStorage.setItem('energyHistory', JSON.stringify(energyHistory));

    const btn = document.querySelector(`.cooked-btn[data-recipe-id="${messageId}"]`);
    if (btn) {
        btn.classList.add('cooked');
        btn.innerHTML = '<i class="fas fa-check-circle"></i> Приготовлено';
        btn.disabled = true;
    }
    const rate = getExchangeRateSync('BYN', userCurrency);
    const displayCost = (baseCost * rate).toFixed(2);
    showToast(`Учтено: ${consumption} кВт·ч (${displayCost} ${userCurrency})`, 'success');
}function renderEnergyCharts() {
    const rate = getExchangeRateSync('BYN', userCurrency);
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const hourlyCtx = document.getElementById('hourlyChart')?.getContext('2d');
    if (hourlyCtx) {
        const hours = Array.from({ length: 24 }, (_, i) => i);
        const hourlyData = hours.map(h => {
            const entries = energyHistory.filter(e => e.date === todayStr && e.hour === h);
            const consumption = entries.reduce((sum, e) => sum + (e.consumption || 0), 0);
            return { consumption, cost: consumption * 0.15 * rate };
        });
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(hourlyCtx, {
            type: 'bar',
            data: {
                labels: hours.map(h => `${h}:00`),
                datasets: [
                    {
                        label: 'кВт·ч',
                        data: hourlyData.map(d => d.consumption),
                        backgroundColor: '#2e5c3e',
                        yAxisID: 'y'
                    },
                    {
                        label: `Стоимость (${userCurrency})`,
                        data: hourlyData.map(d => d.cost.toFixed(2)),
                        type: 'line',
                        borderColor: '#ffa726',
                        yAxisID: 'y1',
                        tension: 0.1,
                        fill: false
                    }
                ]
            },
            options: {
                plugins: { title: { display: true, text: `Почасовое потребление за ${todayStr}` } },
                scales: {
                    y: { beginAtZero: true, position: 'left', title: { display: true, text: 'кВт·ч' } },
                    y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: userCurrency } }
                }
            }
        });
    }
    const dailyCtx = document.getElementById('dailyChart')?.getContext('2d');
    if (dailyCtx) {
        const labels = [], consumptionData = [], costData = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const dayEntry = energyHistory.find(e => e.date === dateStr);
            const consumption = dayEntry ? dayEntry.consumption : 0;
            labels.push(dateStr.slice(5));
            consumptionData.push(consumption);
            costData.push((consumption * 0.15 * rate).toFixed(2));
        }
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(dailyCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'кВт·ч', data: consumptionData, borderColor: '#1f4029', yAxisID: 'y' },
                    { label: `Стоимость (${userCurrency})`, data: costData, borderColor: '#ffa726', yAxisID: 'y1', tension: 0.1, fill: false }
                ]
            },
            options: {
                scales: {
                    y: { beginAtZero: true, position: 'left', title: { display: true, text: 'кВт·ч' } },
                    y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: userCurrency } }
                }
            }
        });
    }
    const totalConsumption = energyHistory.reduce((sum, e) => sum + e.consumption, 0);
    const totalBaseCost = totalConsumption * 0.15;
    document.getElementById('energyStatsSummary').innerHTML = `
        <div class="stat-card"><div class="stat-value">${totalConsumption.toFixed(1)}</div><div class="stat-label">кВт·ч</div></div>
        <div class="stat-card"><div class="stat-value">${(totalBaseCost * rate).toFixed(2)}</div><div class="stat-label">${userCurrency}</div></div>
        <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Экономия</div></div>
    `;
}

function renderForecast() {
    const container = document.getElementById('forecastContainer');
    if (!container) return;
    const currentHash = JSON.stringify(energyHistory.slice(-30).map(e => e.consumption));
    if (currentHash === lastForecastHash) return;
    lastForecastHash = currentHash;
    container.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка прогноза...';
    const recentEnergy = energyHistory.slice(-30);
    const totalConsumption = recentEnergy.reduce((sum, e) => sum + e.consumption, 0);
    const avgDaily = recentEnergy.length > 0 ? totalConsumption / recentEnergy.length : 0;
    const forecastDays = [], forecastConsumption = [];
    for (let i = 1; i <= 30; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        forecastDays.push(d.toISOString().split('T')[0].slice(5));
        forecastConsumption.push(avgDaily);
    }
    const rate = getExchangeRateSync('BYN', userCurrency);
    const forecastCost = forecastConsumption.map(v => (v * 0.15 * rate).toFixed(2));
    callAI(`Дай краткий совет по экономии энергии на кухне на месяц (30 дней) при среднем потреблении ${avgDaily.toFixed(2)} кВт·ч в день.`).then(advice => {
        container.innerHTML = `
            <div class="forecast-chart">
                <canvas id="forecastCanvas"></canvas>
            </div>
            <div class="forecast-recommendation">
                <h4><i class="fas fa-lightbulb"></i> ИИ‑прогноз</h4>
                <p>${advice.replace(/\n/g, '<br>')}</p>
            </div>
        `;
        const ctx = document.getElementById('forecastCanvas')?.getContext('2d');
        if (ctx) {
            if (forecastChart) forecastChart.destroy();
            forecastChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: forecastDays,
                    datasets: [
                        { label: 'Прогноз кВт·ч', data: forecastConsumption, borderColor: '#2e5c3e', yAxisID: 'y' },
                        { label: `Прогноз стоимости (${userCurrency})`, data: forecastCost, borderColor: '#ffa726', yAxisID: 'y1', tension: 0.1, fill: false }
                    ]
                },
                options: {
                    scales: {
                        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'кВт·ч' } },
                        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: userCurrency } }
                    }
                }
            });
        }
    });
}

// ============================================
//  ОТПРАВКА СООБЩЕНИЙ
// ============================================
function buildCookingPrompt(userQuery, mealType, mode) {
    const productList = products.map(p => {
        const expiry = calculateExpiry(p.purchaseDate, p.expiryDays, p.storage, p.opened);
        const daysLeft = getDaysLeft(expiry);
        return `- ${p.name} (${p.storage}, осталось ${daysLeft} дн., ${p.opened ? 'вскрыто' : 'закрыто'}, ${p.weight || 0} г)`;
    }).join('\n');
    const appliances = settings.appliances.join(', ');
    let modeNote = '';
    if (mode === 'eco') modeNote = '\nРежим "Эконом": минимизируй энергозатраты.';
    else if (mode === 'unlimited') modeNote = '\nРежим "Неограниченный": энергозатраты не важны.';
    return `Пользователь хочет приготовить ${mealType}.${modeNote}
Продукты: ${productList || 'холодильник пуст'}
Оборудование: ${appliances}
Запрос: ${userQuery}
Валюта: ${userCurrency}. Напиши подробный рецепт с граммовками и шагами. В конце укажи примерные энергозатраты (кВт·ч) – **не более 5 кВт·ч**, а также процент экономии относительно самого энергозатратного способа. **Не упоминай стоимость, тарифы на электроэнергию или цены – мы добавим их сами.** Дай краткий совет по энергосбережению.`;
}

function makeChatTitle(text, mealType) {
    const source = `${mealType || ''} ${text || ''}`.toLowerCase();
    const topics = [
        ['завтрак', 'Завтрак'], ['обед', 'Обед'], ['ужин', 'Ужин'], ['полдник', 'Полдник'],
        ['десерт', 'Десерт'], ['торт', 'Десерт'], ['печень', 'Выпечка'], ['пирог', 'Выпечка'],
        ['суп', 'Суп'], ['борщ', 'Суп'], ['салат', 'Салат'], ['паста', 'Паста'], ['макарон', 'Паста'],
        ['рис', 'Рис'], ['каша', 'Каша'], ['омлет', 'Омлет'], ['яичн', 'Завтрак'],
        ['напит', 'Напитки'], ['коктейл', 'Напитки'], ['сэндвич', 'Перекус'], ['бутерброд', 'Перекус'],
        ['куриц', 'Курица'], ['мяс', 'Мясо'], ['рыб', 'Рыба'], ['картоф', 'Картофель']
    ];
    for (const [word, title] of topics) {
        if (source.includes(word)) return title;
    }
    return ({завтрак: 'Завтрак', обед: 'Обед', ужин: 'Ужин', полдник: 'Полдник'})[mealType] || 'Готовка';
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    let text = input.value.trim();
    if (!currentChatId) {
        currentChatId = await db.chats.add({ title: 'Новый чат', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
    }
    const mealType = document.getElementById('mealTypeSelect')?.value || 'ужин';
    const mode = document.getElementById('cookingModeSelect')?.value || 'normal';
    if (!text) {
        text = `Предложи рецепт на ${mealType} в ${mode === 'eco' ? 'экономном' : mode === 'unlimited' ? 'неограниченном' : 'обычном'} режиме`;
        input.value = text;
    }
    isLoading = true;
    input.disabled = true;
    document.getElementById('sendBtn').disabled = true;
    await db.messages.add({ chatId: currentChatId, role: 'user', content: text, timestamp: new Date() });
    await db.chats.update(currentChatId, { updatedAt: new Date() });
    await renderMessages();
    const tempId = await db.messages.add({ chatId: currentChatId, role: 'bot', content: '⏳ Готовлю ответ...', timestamp: new Date() });
    await renderMessages();
    let response;
    try {
        response = await callAI(buildCookingPrompt(text, mealType, mode));
    } catch (error) {
        console.error('sendMessage AI error:', error);
        response = '❌ Не удалось получить ответ ИИ. Проверьте ключ Gemini и интернет-соединение.';
    }
    await db.messages.update(tempId, { content: response });
    const chat = await db.chats.get(currentChatId);
    if (chat && chat.title === 'Новый чат') {
        const short = makeChatTitle(text, mealType);
        await db.chats.update(currentChatId, { title: short });
        await renderChatList();
        updateChatTitle();
    }
    await renderMessages();
    isLoading = false;
    input.disabled = false;
    document.getElementById('sendBtn').disabled = false;
    input.value = '';
    input.focus();
}

// ============================================
//  ХРАНИЛИЩЕ
// ============================================
function renderFridge() {
    const list = document.getElementById('fridgeList');
    if (!list) return;
    const filtered = products.filter(p => p.storage === currentTab);
    if (!filtered.length) {
        list.innerHTML = `<div style="grid-column:1/-1; padding:20px; text-align:center; color:var(--text-secondary);">${currentTab === 'fridge' ? 'Холодильник пуст' : currentTab === 'freezer' ? 'Морозилка пуста' : 'Шкафчик пуст'}</div>`;
        return;
    }
    list.innerHTML = '';
    filtered.sort((a,b) => {
        const expA = calculateExpiry(a.purchaseDate, a.expiryDays, a.storage, a.opened);
        const expB = calculateExpiry(b.purchaseDate, b.expiryDays, b.storage, b.opened);
        return expA - expB;
    }).forEach(p => {
        const expiry = calculateExpiry(p.purchaseDate, p.expiryDays, p.storage, p.opened);
        const daysLeft = getDaysLeft(expiry);
        let badgeClass = 'expiry-green';
        if (daysLeft < 0) badgeClass = 'expiry-red';
        else if (daysLeft <= 3) badgeClass = 'expiry-yellow';
        let actionsHtml = '';
        if (daysLeft <= 2 && daysLeft >= 0 && p.storage !== 'freezer') {
            actionsHtml += `<button class="btn-icon-small freeze-product" data-id="${p.id}" title="Переместить в морозилку"><i class="fas fa-snowflake"></i></button>`;
        }
        if (daysLeft < 0) {
            actionsHtml += `<button class="btn-icon-small delete-expired-product" data-id="${p.id}" title="Удалить просроченный продукт"><i class="fas fa-trash-alt"></i></button>`;
        }
        actionsHtml += `<button class="btn-icon-small info-product" data-id="${p.id}"><i class="fas fa-info-circle"></i></button>
                        <button class="btn-icon-small delete-product" data-id="${p.id}"><i class="fas fa-times"></i></button>`;
        const li = document.createElement('li');
        li.className = 'fridge-item';
        li.innerHTML = `
            <div class="item-name">${p.name}</div>
            <div class="item-weight">${p.weight || 0} г</div>
            <div class="item-badges">
                <span class="expiry-badge ${badgeClass}">${daysLeft >= 0 ? daysLeft + ' дн' : 'просрочен'}</span>
            </div>
            <div class="item-opened">
    <input type="checkbox" class="opened-checkbox" data-id="${p.id}" ${p.opened ? 'checked' : ''}>
</div>
            <div class="product-actions">${actionsHtml}</div>
        `;
        li.querySelector('.info-product')?.addEventListener('click', () => showProductInfo(p));
        li.querySelector('.delete-product')?.addEventListener('click', () => deleteProduct(p.id));
        li.querySelector('.freeze-product')?.addEventListener('click', () => moveToFreezer(p));
        li.querySelector('.delete-expired-product')?.addEventListener('click', () => deleteExpiredProduct(p));
        list.appendChild(li);
        li.querySelector('.opened-checkbox').addEventListener('change', (e) => {
    e.stopPropagation();
    toggleProductOpened(p.id, e.target.checked);
});
    });
}

async function toggleProductOpened(id, opened) {
    const product = products.find(p => p.id === id);
    if (!product) return;
    product.opened = opened;
    await db.products.update(id, { opened });
    renderFridge();
    updateRecommendationBadge();
    showToast(`Продукт "${product.name}" ${opened ? 'вскрыт' : 'закрыт'}`, 'info');
}

async function moveToFreezer(product) {
    document.getElementById('freezeProductName').textContent = `Переместить "${product.name}" в морозилку?`;
    document.getElementById('freezeConfirmModal').classList.add('show');
    document.getElementById('confirmFreezeBtn').onclick = async () => {
        product.storage = 'freezer';
        await db.products.update(product.id, { storage: 'freezer' });
        renderFridge();
        document.getElementById('freezeConfirmModal').classList.remove('show');
        showToast(`${product.name} перемещён в морозилку`, 'success');
    };
    document.getElementById('cancelFreezeBtn').onclick = () => document.getElementById('freezeConfirmModal').classList.remove('show');
}

async function deleteExpiredProduct(product) {
    document.getElementById('deleteExpiredMessage').textContent = `Удалить просроченный продукт "${product.name}"?`;
    document.getElementById('deleteExpiredConfirmModal').classList.add('show');
    document.getElementById('confirmDeleteExpiredBtn').onclick = async () => {
        await deleteProduct(product.id);
        document.getElementById('deleteExpiredConfirmModal').classList.remove('show');
    };
    document.getElementById('cancelDeleteExpiredBtn').onclick = () => document.getElementById('deleteExpiredConfirmModal').classList.remove('show');
}

async function deleteProduct(id) {
    await db.products.delete(id);
    products = products.filter(p => p.id !== id);
    renderFridge();
    updateRecommendationBadge();
    showToast('Продукт удалён', 'info');
}

async function addProduct() {
    const select = document.getElementById('productCategory');
    const category = select.value;
    let productName;
    let expiryDays;
    const weight = parseInt(document.getElementById('productWeight').value);
    if (!weight || weight <= 0) {
        showToast('Укажите вес продукта', 'error');
        return;
    }
    if (category === 'custom') {
        const customInput = document.getElementById('customProductName');
        const daysInput = document.getElementById('customExpiryDays');
        if (!customInput.value.trim()) {
            showToast('Введите название', 'error');
            return;
        }
        productName = correctProductName(customInput.value.trim());
        expiryDays = daysInput.value ? parseInt(daysInput.value) : 0;
    } else {
        productName = select.options[select.selectedIndex].text.split(' (')[0];
        expiryDays = 0;
    }
    const purchaseDate = document.getElementById('purchaseDate').value;
    if (!purchaseDate) {
        showToast('Выберите дату покупки', 'error');
        return;
    }
    const storage = document.querySelector('input[name="storage"]:checked').value;
    const opened = document.getElementById('openedCheckbox').checked;
    if (!expiryDays) {
        expiryDays = CONFIG.EXPIRY_DAYS[category] || (await guessExpiry(productName));
    }
    const id = await db.products.add({
        name: productName,
        category,
        purchaseDate,
        expiryDays,
        storage,
        opened,
        weight,
        customName: category === 'custom' ? productName : null
    });
    products.push({ id, name: productName, category, purchaseDate, expiryDays, storage, opened, weight });
    renderFridge();
    updateRecommendationBadge();
    showToast(`${productName} добавлен`, 'success');
    if (category === 'custom') {
        document.getElementById('customProductName').value = '';
        document.getElementById('customExpiryDays').value = '';
    }
    document.getElementById('openedCheckbox').checked = false;
    document.getElementById('productWeight').value = '';
}

async function guessExpiry(productName) {
    const prompt = `Средний срок хранения продукта "${productName}" в холодильнике (в днях). Только число.`;
    const resp = await callAI(prompt);
    const days = parseInt(resp);
    return days > 0 ? days : 5;
}

async function showProductInfo(product) {
    const modal = document.getElementById('productInfoModal');
    const body = document.getElementById('productInfoBody');
    if (!modal || !body) return;
    const expiry = calculateExpiry(product.purchaseDate, product.expiryDays, product.storage, product.opened);
    const daysLeft = getDaysLeft(expiry);
    const purchase = new Date(product.purchaseDate).toLocaleDateString('ru-RU');
    document.getElementById('productBasicInfo').innerHTML = `
        <p><strong>${product.name}</strong> ${product.opened ? '<span style="color:var(--warning);">(вскрыто)</span>' : ''}</p>
        <p>📅 Добавлен: ${purchase}</p>
        <p>⏳ Срок годности: ${daysLeft >= 0 ? daysLeft + ' дн.' : 'истёк'}</p>
        <p>❄️ Хранение: ${product.storage === 'fridge' ? 'Холодильник' : product.storage === 'freezer' ? 'Морозилка' : 'Шкафчик'}</p>
    `;
    const analysisDiv = document.getElementById('aiAnalysisContent');
    analysisDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Анализирую продукт...';
    modal.classList.add('show');
    modal.dataset.currentProductId = product.id;
    try {
        const analysis = await getAIProductAnalysis(product);
        analysisDiv.innerHTML = analysis.replace(/\n/g, '<br>').replace(/\*/g, '');
    } catch (e) {
        analysisDiv.innerHTML = 'Не удалось получить анализ.';
    }
}

async function getAIProductAnalysis(product) {
    const prompt = `Проанализируй продукт "${product.name}" (категория: ${product.category}, хранится в ${product.storage}, вес ${product.weight}г, дата покупки ${product.purchaseDate}, срок хранения ${product.expiryDays} дн., упаковка ${product.opened ? 'вскрыта' : 'закрыта'}). Рассчитай оставшийся срок с учётом условий хранения и вскрытия. Дай краткие рекомендации на русском, без разметки.`;
    return await callAI(prompt);
}

// ============================================
//  РЕКОМЕНДАЦИИ
// ============================================
async function showRecommendations() {
    const modal = document.getElementById('recommendationsModal');
    modal.classList.add('show');
    const cookBtn = document.getElementById('cookFromRecommendationBtn');
    cookBtn.classList.add('hidden');

    // Считаем срочными все продукты, у которых срок истекает в ближайшие 3 дня
    // или уже истёк. Морозилка тоже учитывается по рассчитанному сроку.
    const urgentProducts = products
        .map(p => ({
            ...p,
            daysLeft: getDaysLeft(calculateExpiry(p.purchaseDate, p.expiryDays, p.storage, p.opened))
        }))
        .filter(p => p.daysLeft <= 3)
        .sort((a, b) => a.daysLeft - b.daysLeft);

    const listContainer = document.getElementById('urgentProductsList');
    listContainer.innerHTML = '';
    const comboBtn = document.getElementById('comboRecommendationBtn');

    if (urgentProducts.length === 0) {
        listContainer.innerHTML = '<p>🎉 Сейчас нет продуктов, срок которых заканчивается в ближайшие 3 дня.</p>';
        document.getElementById('recommendationTextDisplay').innerHTML =
            'Здесь появятся продукты, которые лучше использовать в первую очередь.';
        comboBtn.classList.add('hidden');
        return;
    }

    comboBtn.classList.remove('hidden');

    urgentProducts.forEach(p => {
        const card = document.createElement('div');
        card.className = 'urgent-product-card';
        card.dataset.productId = p.id;
        const expiryText = p.daysLeft < 0
            ? `просрочен на ${Math.abs(p.daysLeft)} дн.`
            : p.daysLeft === 0 ? 'истекает сегодня' : `осталось ${p.daysLeft} дн.`;
        const badgeClass = p.daysLeft <= 1 ? 'expiry-red' : 'expiry-yellow';
        card.innerHTML = `
            <div class="product-card-header">
                <span class="product-card-name">${p.name}</span>
                <div class="product-card-badges">
                    <span class="expiry-badge ${badgeClass}">${expiryText}</span>
                    ${p.opened ? '<span class="expiry-badge" style="background: var(--warning);">вскрыто</span>' : ''}
                </div>
            </div>
            <div class="product-card-details" id="details-${p.id}"></div>
        `;
        card.addEventListener('click', async () => {
            document.querySelectorAll('.urgent-product-card').forEach(c => c.classList.remove('expanded', 'compatible'));
            card.classList.add('expanded');
            const detailsDiv = document.getElementById(`details-${p.id}`);
            if (!detailsDiv.hasAttribute('data-loaded')) {
                detailsDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Ищу способ использовать продукт...';
                const prompt = `Продукт "${p.name}" ${p.daysLeft < 0 ? `уже просрочен на ${Math.abs(p.daysLeft)} дней` : `имеет ${p.daysLeft} дней до окончания срока`}. Хранение: ${p.storage === 'freezer' ? 'морозилка' : p.storage === 'fridge' ? 'холодильник' : 'шкафчик'}. ${p.opened ? 'Упаковка вскрыта.' : 'Упаковка закрыта.'} Кратко скажи, как безопасно поступить с ним и, если продукт ещё пригоден, как лучше использовать его в блюде. Не предлагай использовать явно испорченный продукт.`;
                const rec = await callAI(prompt);
                detailsDiv.innerHTML = rec.replace(/\n/g, '<br>');
                detailsDiv.setAttribute('data-loaded', 'true');
            }
            document.getElementById('recommendationTextDisplay').innerHTML = detailsDiv.innerHTML;
            cookBtn.classList.remove('hidden');
        });
        listContainer.appendChild(card);
    });

    comboBtn.onclick = async () => {
        const usable = urgentProducts.filter(p => p.daysLeft >= 0);
        if (usable.length === 0) {
            document.getElementById('recommendationTextDisplay').innerHTML =
                '⚠️ Все найденные продукты уже просрочены. Не стоит использовать их для приготовления.';
            cookBtn.classList.add('hidden');
            return;
        }

        const productData = usable.map(p =>
            `- ${p.name}: ${p.weight || '?'} г, осталось ${p.daysLeft} дн., ${p.opened ? 'вскрыт' : 'закрыт'}`
        ).join('\n');
        const prompt = `У пользователя есть продукты, которые нужно использовать в первую очередь:\n${productData}\n\nПридумай ОДНО реальное блюдо, которое использует минимум 2 из этих продуктов (если продуктов меньше двух — используй доступный продукт и обычные базовые ингредиенты). Выбирай продукты с меньшим сроком в первую очередь. Не используй продукты с отрицательным остатком срока. Напиши: название блюда, какие продукты из списка используются, остальные нужные ингредиенты, краткие шаги и время приготовления. Не выдумывай наличие других продуктов у пользователя. Ответь по-русски, без Markdown-таблиц.`;
        document.getElementById('recommendationTextDisplay').innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> Подбираю блюдо из продуктов...';
        const comboRec = await callAI(prompt);
        document.getElementById('recommendationTextDisplay').innerHTML = comboRec.replace(/\n/g, '<br>');
        const usedNames = usable.map(p => p.name.toLowerCase());
        document.querySelectorAll('.urgent-product-card').forEach(card => {
            const name = card.querySelector('.product-card-name')?.textContent?.toLowerCase() || '';
            if (usedNames.some(n => name.includes(n) || n.includes(name))) card.classList.add('compatible');
        });
        cookBtn.classList.remove('hidden');
    };

    cookBtn.onclick = async () => {
        const recipeText = document.getElementById('recommendationTextDisplay').innerText;
        if (!recipeText.trim() || recipeText.includes('Все найденные продукты уже просрочены')) return;
        modal.classList.remove('show');
        let recChat = await db.chats.where('title').equals('Рекомендации').first();
        if (!recChat) {
            const id = await db.chats.add({ title: 'Рекомендации', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
            recChat = { id };
        }
        switchChat(recChat.id);
        document.getElementById('messageInput').value = `Приготовь: ${recipeText}`;
        sendMessage();
    };
}
// ============================================
//  ПРОФИЛЬ
// ============================================
function showProfileModal() {
    document.getElementById('profileModal').classList.add('show');
    fillAboutSection();
    initProfileTabs();
    initAccordion();
}

function hideProfileModal() {
    document.getElementById('profileModal').classList.remove('show');
}

function enableProfileNameEdit() {
    const display = document.getElementById('profileNameDisplay');
    const input = document.getElementById('profileNameInput');
    const editBtn = document.getElementById('editProfileNameBtn');
    display.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    editBtn.style.display = 'none';
    const save = () => {
        profileName = input.value.trim() || 'Пользователь';
        localStorage.setItem('profileName', profileName);
        display.textContent = profileName;
        display.classList.remove('hidden');
        input.classList.add('hidden');
        editBtn.style.display = 'block';
        showToast('Имя сохранено', 'success');
        updateProfileUI();
    };
    input.addEventListener('blur', save, { once: true });
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
}

function changeAvatar() {
    document.getElementById('emojiPickerModal').classList.add('show');
}

function selectEmoji(emoji) {
    profileAvatar = emoji;
    localStorage.setItem('profileAvatar', profileAvatar);
    updateProfileUI();
    document.getElementById('emojiPickerModal').classList.remove('show');
    showToast('Аватар обновлён', 'success');
}

function fillAboutSection() {
    document.getElementById('likedIngredients').value = userTasteProfile.likedIngredients.join(', ');
    document.getElementById('dislikedIngredients').value = userTasteProfile.dislikedIngredients.join(', ');
    document.getElementById('sweetCheck').checked = userTasteProfile.sweetTooth;
    document.getElementById('saltyCheck').checked = userTasteProfile.salty;
    document.getElementById('bitterCheck').checked = userTasteProfile.bitter;
    document.getElementById('sourCheck').checked = userTasteProfile.sour;
    document.getElementById('fastFoodInput').value = userTasteProfile.fastFood.join(', ');
    document.getElementById('cuisineNotes').value = userTasteProfile.cuisineNotes;
    document.getElementById('ingredientsNotes').value = userTasteProfile.ingredientsNotes;
    document.querySelectorAll('.cuisine-check').forEach(cb => {
        cb.checked = userTasteProfile.likedCuisines.includes(cb.value);
    });
}

function saveAboutSection() {
    userTasteProfile.likedCuisines = Array.from(document.querySelectorAll('.cuisine-check:checked')).map(cb => cb.value);
    userTasteProfile.likedIngredients = document.getElementById('likedIngredients').value.split(',').map(s => s.trim()).filter(Boolean);
    userTasteProfile.dislikedIngredients = document.getElementById('dislikedIngredients').value.split(',').map(s => s.trim()).filter(Boolean);
    userTasteProfile.sweetTooth = document.getElementById('sweetCheck').checked;
    userTasteProfile.salty = document.getElementById('saltyCheck').checked;
    userTasteProfile.bitter = document.getElementById('bitterCheck').checked;
    userTasteProfile.sour = document.getElementById('sourCheck').checked;
    userTasteProfile.fastFood = document.getElementById('fastFoodInput').value.split(',').map(s => s.trim()).filter(Boolean);
    userTasteProfile.cuisineNotes = document.getElementById('cuisineNotes').value;
    userTasteProfile.ingredientsNotes = document.getElementById('ingredientsNotes').value;
    localStorage.setItem('userTasteProfile', JSON.stringify(userTasteProfile));
    showToast('Предпочтения сохранены', 'success');
}

function showCountryInputModal() {
    const old = document.getElementById('countryModal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.id = 'countryModal';
    modal.style.zIndex = '3001';
    modal.innerHTML = `
    <div class="modal-content modal-small">
      <div class="modal-header"><h3>Введите страну</h3><button class="modal-close" id="closeCountryModalBtn">&times;</button></div>
      <div class="modal-body">
        <input type="text" id="countryInput" class="question-input" placeholder="Название страны" value="${userCountry}">
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelCountryBtn">Отмена</button>
        <button class="btn btn-primary" id="confirmCountryBtn">Применить</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#closeCountryModalBtn');
    const cancelBtn = modal.querySelector('#cancelCountryBtn');
    const confirmBtn = modal.querySelector('#confirmCountryBtn');
    const input = modal.querySelector('#countryInput');
    const removeModal = () => modal.remove();

    closeBtn.addEventListener('click', removeModal);
    cancelBtn.addEventListener('click', removeModal);
    confirmBtn.addEventListener('click', async () => {
        const country = input.value.trim();
        if (!country) return;

        const localCountries = {
            'Россия': '🇷🇺', 'Беларусь': '🇧🇾', 'Украина': '🇺🇦',
            'Казахстан': '🇰🇿', 'США': '🇺🇸', 'Германия': '🇩🇪',
            'Франция': '🇫🇷', 'Великобритания': '🇬🇧', 'Италия': '🇮🇹',
            'Испания': '🇪🇸', 'Польша': '🇵🇱', 'Турция': '🇹🇷',
            'Китай': '🇨🇳', 'Япония': '🇯🇵', 'Канада': '🇨🇦'
        };

        const foundEntry = Object.entries(localCountries).find(([name]) => name.toLowerCase() === country.toLowerCase());
        if (foundEntry) {
            userCountry = foundEntry[0];
            localStorage.setItem('userCountry', userCountry);
            updateProfileUI();
            if (!userCurrency) {
                const currResp = await callAI(`Валюта страны ${userCountry}. Ответь только кодом (например, USD).`);
                userCurrency = currResp.trim().toUpperCase();
                localStorage.setItem('userCurrency', userCurrency);
                updateProfileUI();
            }
            if (document.getElementById('energyTab')?.classList.contains('active')) {
                updateKwhRateDisplay();
                renderEnergyCharts();
            }
            showToast(`Страна: ${userCountry}`, 'success');
            removeModal();
            return;
        }

        const resp = await callAI(`Проверь, существует ли страна "${country}". Если да, верни точное название страны и её флаг эмодзи. Формат: "название | флаг". Если страны нет, напиши "нет".`);
        const parts = resp.trim().split('|');
        if (parts.length === 2 && parts[0].trim().length > 1) {
            userCountry = parts[0].trim();
            localStorage.setItem('userCountry', userCountry);
            updateProfileUI();
            if (!userCurrency) {
                const currResp = await callAI(`Валюта страны ${userCountry}. Ответь только кодом (например, USD).`);
                userCurrency = currResp.trim().toUpperCase();
                localStorage.setItem('userCurrency', userCurrency);
                updateProfileUI();
            }
            if (document.getElementById('energyTab')?.classList.contains('active')) {
                updateKwhRateDisplay();
                renderEnergyCharts();
            }
            showToast(`Страна: ${userCountry}`, 'success');
        } else {
            showToast('Страна не найдена', 'error');
        }
        removeModal();
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) removeModal();
    });
}
function showCurrencyInputModal() {
    const old = document.getElementById('currencyModal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.id = 'currencyModal';
    modal.style.zIndex = '3001';
    modal.innerHTML = `
    <div class="modal-content modal-small">
      <div class="modal-header"><h3>Введите валюту</h3><button class="modal-close" id="closeCurrencyModalBtn">&times;</button></div>
      <div class="modal-body">
        <input type="text" id="currencyInput" class="question-input" placeholder="Код валюты (например, USD)" value="${userCurrency}">
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelCurrencyBtn">Отмена</button>
        <button class="btn btn-primary" id="confirmCurrencyBtn">Применить</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#closeCurrencyModalBtn');
    const cancelBtn = modal.querySelector('#cancelCurrencyBtn');
    const confirmBtn = modal.querySelector('#confirmCurrencyBtn');
    const input = modal.querySelector('#currencyInput');
    const removeModal = () => modal.remove();

    closeBtn.addEventListener('click', removeModal);
    cancelBtn.addEventListener('click', removeModal);
    confirmBtn.addEventListener('click', async () => {
        const currency = input.value.trim().toUpperCase();
        if (!currency) return;

        const localCurrencies = {
            'RUB': '🇷🇺', 'USD': '🇺🇸', 'EUR': '🇪🇺', 'BYN': '🇧🇾',
            'UAH': '🇺🇦', 'KZT': '🇰🇿', 'PLN': '🇵🇱', 'TRY': '🇹🇷'
        };

        if (localCurrencies[currency]) {
            userCurrency = currency;
            localStorage.setItem('userCurrency', userCurrency);
            updateProfileUI();
            // Обновить графики, если вкладка активна
            if (document.getElementById('energyTab')?.classList.contains('active')) {
                updateKwhRateDisplay();
                renderEnergyCharts();
            }
            showToast(`Валюта: ${userCurrency}`, 'success');
            removeModal();
            return;
        }

        const resp = await callAI(`Проверь, существует ли валюта с кодом "${currency}". Ответь строго в формате "код | флаг_эмодзи_страны". Если валюты нет, напиши "нет".`);
        const parts = resp.trim().split('|');
        if (parts.length === 2 && parts[0].trim().length <= 5) {
            userCurrency = parts[0].trim().toUpperCase();
            localStorage.setItem('userCurrency', userCurrency);
            updateProfileUI();
            if (document.getElementById('energyTab')?.classList.contains('active')) {
                updateKwhRateDisplay();
                renderEnergyCharts();
            }
            showToast(`Валюта: ${userCurrency}`, 'success');
        } else {
            showToast('Валюта не найдена', 'error');
        }
        removeModal();
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) removeModal();
    });
}
function initProfileTabs() {
    document.querySelectorAll('.profile-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.profile-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.profile-tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(tab + 'Tab').classList.add('active');
            if (tab === 'energy') {
                updateKwhRateDisplay();
                renderEnergyCharts();
                renderApplianceConsumption();
            } else if (tab === 'forecast') {
                renderForecast();
            }
        });
    });
}

async function updateKwhRateDisplay() {
    const rate = await getExchangeRate('BYN', userCurrency);
    const el = document.getElementById('kwhRateDisplay');
    if (el) el.textContent = `${(0.25 * rate).toFixed(2)} ${userCurrency}`;
}

function renderApplianceConsumption() {
    const container = document.getElementById('applianceConsumptionList');
    if (!container) return;
    container.innerHTML = '';
    settings.appliances.forEach(app => {
        const base = CONFIG.ENERGY[app] || 1.0;
        const card = document.createElement('div');
        card.className = 'appliance-card';
        card.innerHTML = `
            <div class="appliance-name"><i class="fas fa-plug"></i> ${app}</div>
            <div class="consumption-levels">
                <div class="level-item"><div class="level-label">Эконом</div><div class="level-value">${(base * 0.7).toFixed(2)}</div></div>
                <div class="level-item"><div class="level-label">Средне</div><div class="level-value">${base.toFixed(2)}</div></div>
                <div class="level-item"><div class="level-label">Макс</div><div class="level-value">${(base * 1.3).toFixed(2)}</div></div>
            </div>
            <div style="margin-top:8px; font-size:0.8rem; color:var(--text-secondary);">кВт·ч</div>
        `;
        container.appendChild(card);
    });
}

function initAccordion() {
    document.querySelectorAll('.accordion-header').forEach(header => {
        if (header.dataset.accordionInitialized) return;
        header.dataset.accordionInitialized = 'true';
        header.addEventListener('click', () => {
            const body = header.nextElementSibling;
            body.classList.toggle('open');
            const icon = header.querySelector('i');
            icon.classList.toggle('fa-chevron-down');
            icon.classList.toggle('fa-chevron-up');
        });
    });
}

// ============================================
//  НАСТРОЙКИ КУХНИ
// ============================================
function showSettingsModal() {
    document.getElementById('settingsModal').classList.add('show');
}

async function saveSettings() {
    const checkboxes = document.querySelectorAll('.appliance-check:checked');
    settings.appliances = Array.from(checkboxes).map(cb => cb.value);
    await db.settings.put({ key: 'appSettings', value: settings });
    document.getElementById('settingsModal').classList.remove('show');
    showToast('Настройки сохранены', 'success');
}

// ============================================
//  ЧАТЫ И ПЕРЕИМЕНОВАНИЕ
// ============================================
async function switchChat(id) {
    currentChatId = id;
    localStorage.setItem('lastChatId', id);
    await renderAll();
}

async function deleteChat(id) {
    await db.messages.where('chatId').equals(id).delete();
    await db.chats.delete(id);
    if (currentChatId === id) {
        const chats = await db.chats.toArray();
        currentChatId = chats.length ? chats[0].id : null;
        if (!currentChatId) {
            currentChatId = await db.chats.add({ title: 'Новый чат', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
        }
    }
    await renderAll();
    showToast('Чат удалён', 'info');
}

async function createNewChat() {
    const id = await db.chats.add({ title: 'Новый чат', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
    switchChat(id);
}

async function renameChat(newTitle) {
    if (!newTitle.trim() || !currentChatId) return;
    await db.chats.update(currentChatId, { title: newTitle.trim() });
    await renderChatList();
    updateChatTitle();
    document.getElementById('renameChatModal').classList.remove('show');
    showToast('Чат переименован', 'success');
}

function showRenameModal() {
    if (!currentChatId) return;
    db.chats.get(currentChatId).then(chat => {
        document.getElementById('newChatTitleInput').value = chat.title || '';
        document.getElementById('renameChatModal').classList.add('show');
    });
}

function updateChatTitle() {
    const titleEl = document.getElementById('currentChatTitle');
    if (!currentChatId || !titleEl) return;
    db.chats.get(currentChatId).then(chat => {
        titleEl.textContent = chat?.title || 'Новый чат';
    });
}

// ============================================
//  ИЗБРАННОЕ
// ============================================
async function showFavorites() {
    const modal = document.getElementById('favoritesModal');
    modal.classList.add('show');
    const list = document.getElementById('favoritesList');
    list.innerHTML = '';
    const favs = await db.favorites.toArray();
    if (favs.length === 0) {
        list.innerHTML = '<li>Нет избранных рецептов</li>';
        document.getElementById('favoriteRecipeDisplay').innerHTML = 'Рецепт не выбран';
        return;
    }
    favs.forEach(fav => {
        const li = document.createElement('li');
        li.textContent = fav.recipeTitle;
        li.addEventListener('click', () => {
            const rate = getExchangeRateSync('BYN', userCurrency);
            const cost = (fav.baseCost || 0) * rate;
            document.getElementById('favoriteRecipeDisplay').innerHTML = `
                <div>${fav.content.replace(/\n/g, '<br>')}</div>
                <div style="margin-top:10px; color:var(--primary);">Ориентировочная стоимость: ${cost.toFixed(2)} ${userCurrency}</div>
                <button class="btn btn-sm btn-primary cook-favorite-btn" data-recipe="${encodeURIComponent(fav.content)}" style="margin-top:12px;">
                    <i class="fas fa-fire"></i> Приготовить
                </button>
                <button class="btn btn-sm btn-danger delete-favorite-btn" data-id="${fav.id}" style="margin-top:12px; margin-left:8px;">
                    <i class="fas fa-trash-alt"></i> Удалить
                </button>
            `;
        });
        list.appendChild(li);
    });
}

async function cookFromFavorite(recipeContent) {
    const decoded = decodeURIComponent(recipeContent);
    document.getElementById('favoritesModal').classList.remove('show');
    const chatId = await db.chats.add({ title: 'Избранное', type: 'cooking', createdAt: new Date(), updatedAt: new Date() });
    await switchChat(chatId);
    const tempId = await db.messages.add({ chatId, role: 'bot', content: '⏳ Готовлю полный рецепт...', timestamp: new Date() });
    await renderMessages();
    const prompt = `Напиши подробный рецепт блюда на основе следующего описания: "${decoded}". Включи список ингредиентов с граммовкой, пошаговые инструкции, примерные энергозатраты и стоимость в ${userCurrency}. Учти режим экономии, если он был указан.`;
    const response = await callAI(prompt);
    await db.messages.update(tempId, { content: response });
    await renderMessages();
}

async function deleteFavorite(id) {
    await db.favorites.delete(id);
    showToast('Рецепт удалён из избранного', 'info');
    showFavorites();
}

// ============================================
//  ИНИЦИАЛИЗАЦИЯ СОБЫТИЙ
// ============================================
function initEventListeners() {
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('newChatBtn').addEventListener('click', createNewChat);
    document.getElementById('renameChatBtn').addEventListener('click', showRenameModal);
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !isLoading) sendMessage();
    });

    document.getElementById('fridgeToggleBtn').addEventListener('click', () => {
        renderFridge();
        document.getElementById('fridgeModal').classList.add('show');
    });
    document.getElementById('closeFridgeModalBtn').addEventListener('click', () => document.getElementById('fridgeModal').classList.remove('show'));
    document.getElementById('addProductBtn').addEventListener('click', addProduct);
    document.getElementById('purchaseDate').valueAsDate = new Date();
    document.getElementById('productCategory').addEventListener('change', (e) => {
        const isCustom = e.target.value === 'custom';
        document.getElementById('customProductName').style.display = isCustom ? 'block' : 'none';
        document.getElementById('customExpiryDays').style.display = isCustom ? 'block' : 'none';
    });
    document.querySelectorAll('#fridgeModal .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentTab = btn.dataset.tab;
            document.querySelectorAll('#fridgeModal .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderFridge();
        });
    });
    document.getElementById('resetEnergyBtn')?.addEventListener('click', () => {
    showConfirmModal(
        'Сбросить статистику?',
        'Вся история энергопотребления будет удалена. Это действие нельзя отменить.',
        async () => {
            await db.energyLog.clear();
            energyHistory = [];
            localStorage.removeItem('energyHistory');
            if (document.getElementById('energyTab')?.classList.contains('active')) {
                renderEnergyCharts();
            }
            showToast('Статистика электроэнергии сброшена', 'info');
        },
        'Сбросить'
    );
});

    document.getElementById('settingsBtn').addEventListener('click', showSettingsModal);
    document.getElementById('closeModalBtn').addEventListener('click', () => document.getElementById('settingsModal').classList.remove('show'));
    document.getElementById('cancelSettingsBtn').addEventListener('click', () => document.getElementById('settingsModal').classList.remove('show'));
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('aiSettingsBtn')?.addEventListener('click', async () => {
        showToast('Проверяю подключение Gemini…', 'info');
        const result = await testGeminiConnection();
        if (result.ok) {
            showToast('✅ Gemini подключён и отвечает.', 'success');
        } else if (result.status === 401 && result.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') {
            showToast('❌ Этот AQ.-ключ сейчас не принимается Gemini API. Нужен рабочий ключ/проект.', 'error');
        } else {
            showToast(`❌ Gemini: HTTP ${result.status || '—'} — ${result.message}`, 'error');
        }
    });

    document.getElementById('confirmCancelBtn').addEventListener('click', hideConfirmModal);
    document.getElementById('confirmOkBtn').addEventListener('click', () => { if (confirmCallback) confirmCallback(); hideConfirmModal(); });

    document.getElementById('closeProductInfoBtn').addEventListener('click', () => document.getElementById('productInfoModal').classList.remove('show'));
    document.getElementById('refreshAnalysisBtn')?.addEventListener('click', async () => {
        const modal = document.getElementById('productInfoModal');
        const productId = modal.dataset.currentProductId;
        if (productId) {
            const product = products.find(p => p.id == productId);
            if (product) {
                const analysisDiv = document.getElementById('aiAnalysisContent');
                analysisDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Обновление анализа...';
                try {
                    const analysis = await getAIProductAnalysis(product);
                    analysisDiv.innerHTML = analysis.replace(/\n/g, '<br>').replace(/\*/g, '');
                } catch (e) {
                    analysisDiv.innerHTML = 'Не удалось обновить анализ.';
                }
            }
        }
    });

    document.getElementById('cancelRenameBtn').addEventListener('click', () => document.getElementById('renameChatModal').classList.remove('show'));
    document.getElementById('confirmRenameBtn').addEventListener('click', () => renameChat(document.getElementById('newChatTitleInput').value));

    document.getElementById('profileBtn').addEventListener('click', showProfileModal);
    document.getElementById('closeProfileBtn').addEventListener('click', hideProfileModal);
    document.getElementById('editProfileNameBtn').addEventListener('click', enableProfileNameEdit);
    document.getElementById('profileAvatar')?.addEventListener('click', changeAvatar);
    document.getElementById('selectCountryBtn')?.addEventListener('click', showCountryInputModal);
    document.getElementById('selectCurrencyBtn')?.addEventListener('click', showCurrencyInputModal);
    document.getElementById('showAppliancesBtn')?.addEventListener('click', () => {
        const panel = document.getElementById('applianceSlidePanel');
        panel.classList.toggle('hidden');
    });
    document.getElementById('saveAboutBtn').addEventListener('click', saveAboutSection);

    document.getElementById('closeEmojiPickerBtn').addEventListener('click', () => document.getElementById('emojiPickerModal').classList.remove('show'));
    document.querySelectorAll('.emoji-item').forEach(item => {
        item.addEventListener('click', (e) => selectEmoji(e.currentTarget.dataset.emoji));
    });

    document.getElementById('favoritesBtn').addEventListener('click', showFavorites);
    document.getElementById('closeFavoritesBtn').addEventListener('click', () => document.getElementById('favoritesModal').classList.remove('show'));
    document.getElementById('favoritesModal').addEventListener('click', async (e) => {
        const target = e.target.closest('button');
        if (!target) return;
        if (target.classList.contains('cook-favorite-btn')) {
            await cookFromFavorite(target.dataset.recipe);
        } else if (target.classList.contains('delete-favorite-btn')) {
            await deleteFavorite(parseInt(target.dataset.id));
        }
    });

    document.getElementById('recommendationsBtn').addEventListener('click', showRecommendations);
    document.getElementById('closeRecommendationsBtn').addEventListener('click', () => document.getElementById('recommendationsModal').classList.remove('show'));

    document.getElementById('kwhInfoIcon')?.addEventListener('click', () => {
        alert('кВт·ч (киловатт-час) — единица измерения электроэнергии. 1 кВт·ч = 1000 Вт × 1 час. Стоимость зависит от тарифа вашей страны.');
    });

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal') && !e.target.closest('.modal-content')) {
            e.target.classList.remove('show');
        }
        if (e.target.classList.contains('fullscreen-modal')) {
            e.target.classList.remove('show');
        }
    });
}

window.addEventListener('load', async () => {
    initEventListeners();
    await loadData();
    console.log('✅ Приложение загружено');
});
