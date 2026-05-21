const crypto = require('crypto');

let cachedToken = null;
let tokenExpiry = 0;
let retryCount = 0;
const MAX_RETRIES = 3;

async function getGigaToken() {
    const credentials = process.env.GIGACHAT_CREDENTIALS;
    
    if (!credentials) {
        console.error('❌ GIGACHAT_CREDENTIALS не заданы в переменных BotHost');
        throw new Error('GigaChat credentials missing. Please set GIGACHAT_CREDENTIALS in BotHost environment variables.');
    }
    
    // Проверяем валидность кэшированного токена
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    
    console.log('🔄 Получение нового токена GigaChat...');
    
    try {
        const response = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Authorization': `Basic ${credentials}`,
                'RqUID': crypto.randomUUID()
            },
            body: 'scope=GIGACHAT_API_PERS'
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`GigaChat Auth Error: ${JSON.stringify(data)}`);
        }
        
        cachedToken = data.access_token;
        // Устанавливаем expiry на 30 секунд раньше для безопасности
        tokenExpiry = Date.now() + (data.expires_at - 30) * 1000;
        
        console.log('✅ Токен GigaChat получен, expires:', new Date(tokenExpiry).toISOString());
        retryCount = 0;
        return cachedToken;
        
    } catch (error) {
        console.error('❌ Ошибка получения токена GigaChat:', error.message);
        throw error;
    }
}

async function callGigaChat(systemPrompt, userPrompt) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const token = await getGigaToken();
            
            console.log(`🔄 Запрос к GigaChat (попытка ${attempt}/${MAX_RETRIES})...`);
            
            const response = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    model: 'GigaChat',
                    temperature: 0.8,
                    max_tokens: 3000,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                // Если токен истек, сбрасываем кэш и пробуем снова
                if (data.message?.includes('token') || response.status === 401) {
                    console.log('🔄 Токен истек, обновляем...');
                    cachedToken = null;
                    tokenExpiry = 0;
                    continue;
                }
                throw new Error(`GigaChat API Error (${response.status}): ${JSON.stringify(data)}`);
            }
            
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                throw new Error('Invalid response structure from GigaChat');
            }
            
            const content = data.choices[0].message.content;
            console.log(`✅ Ответ получен, длина: ${content.length} символов`);
            
            return content;
            
        } catch (error) {
            lastError = error;
            console.error(`❌ Попытка ${attempt} не удалась:`, error.message);
            
            if (attempt < MAX_RETRIES) {
                // Ждем перед повторной попыткой
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    
    throw lastError || new Error('Failed to get response from GigaChat after retries');
}

module.exports = { callGigaChat, getGigaToken };
