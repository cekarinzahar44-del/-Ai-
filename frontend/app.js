// Telegram WebApp initialization
const tg = window.Telegram.WebApp;
tg.expand();
tg.enableClosingConfirmation();

// App state
let currentUser = null;
let currentRecipe = null;
let pendingQuery = null;
let favorites = [];
let mediaRecorder = null;
let audioChunks = [];
let currentPaymentId = null;
let currentPlanType = null;

// Load favorites from localStorage
try {
    const saved = localStorage.getItem('chef_favorites');
    if (saved) favorites = JSON.parse(saved);
} catch(e) {}

// DOM elements
const recipeInput = document.getElementById('recipeInput');
const generateBtn = document.getElementById('generateBtn');
const voiceBtn = document.getElementById('voiceBtn');
const detailsSection = document.getElementById('detailsSection');
const detailsInput = document.getElementById('detailsInput');
const submitDetailsBtn = document.getElementById('submitDetailsBtn');
const loadingSection = document.getElementById('loadingSection');
const recipeSection = document.getElementById('recipeSection');
const favoritesSection = document.getElementById('favoritesSection');
const profileSection = document.getElementById('profileSection');
const userStatusSpan = document.getElementById('userStatus');
const welcomeSection = document.getElementById('welcomeSection');

// Toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type}`;
    toast.querySelector('.toast-message').textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Helper functions
function showLoading() {
    loadingSection.style.display = 'block';
    recipeSection.style.display = 'none';
    detailsSection.style.display = 'none';
    welcomeSection.style.display = 'none';
}

function hideLoading() {
    loadingSection.style.display = 'none';
}

function showRecipe() {
    recipeSection.style.display = 'block';
    welcomeSection.style.display = 'none';
    detailsSection.style.display = 'none';
    favoritesSection.style.display = 'none';
    profileSection.style.display = 'none';
}

function showFavorites() {
    favoritesSection.style.display = 'block';
    recipeSection.style.display = 'none';
    welcomeSection.style.display = 'none';
    detailsSection.style.display = 'none';
    profileSection.style.display = 'none';
    renderFavorites();
}

function showProfile() {
    profileSection.style.display = 'block';
    recipeSection.style.display = 'none';
    welcomeSection.style.display = 'none';
    detailsSection.style.display = 'none';
    favoritesSection.style.display = 'none';
    updateProfile();
}

function showWelcome() {
    welcomeSection.style.display = 'block';
    recipeSection.style.display = 'none';
    detailsSection.style.display = 'none';
    favoritesSection.style.display = 'none';
    profileSection.style.display = 'none';
}

// API calls
async function getUserData() {
    try {
        const response = await fetch(`/api/user/${tg.initDataUnsafe.user.id}`);
        const data = await response.json();
        
        if (data.success) {
            currentUser = data;
            updateUserStatus();
            return data;
        }
    } catch (error) {
        console.error('Error fetching user:', error);
        showToast('Ошибка загрузки данных', 'error');
    }
    return null;
}

function updateUserStatus() {
    if (!currentUser) return;
    
    if (currentUser.hasSubscription) {
        userStatusSpan.innerHTML = `✨ ${currentUser.subscription.plan_type}`;
        const badge = userStatusSpan.querySelector('.status-badge');
        if (badge) badge.style.background = 'linear-gradient(135deg, #FFD700, #FFA500)';
    } else {
        userStatusSpan.innerHTML = `🎁 ${currentUser.freeRecipesLeft}/${currentUser.freeLimit || 3}`;
    }
}

async function generateRecipe(query, details = '') {
    if (!currentUser || !currentUser.canGenerate) {
        showSubscriptionModal();
        return false;
    }
    
    showLoading();
    
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tgId: tg.initDataUnsafe.user.id,
                query: query,
                details: details,
                planType: currentUser.subscription?.plan_type || 'FREE'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayRecipe(data.recipe);
            hideLoading();
            
            // Refresh user data to update free recipes count
            await getUserData();
            return true;
        } else if (data.error === 'FREE_LIMIT_REACHED') {
            hideLoading();
            showSubscriptionModal();
            return false;
        } else {
            throw new Error(data.error || 'Unknown error');
        }
    } catch (error) {
        hideLoading();
        showToast('Ошибка генерации: ' + error.message, 'error');
        return false;
    }
}

function displayRecipe(recipe) {
    currentRecipe = recipe;
    
    // Title
    document.getElementById('recipeTitle').textContent = recipe.title || 'Твой рецепт';
    
    // Description
    const descEl = document.getElementById('recipeDescription');
    if (recipe.description && recipe.description.length > 0) {
        descEl.textContent = recipe.description;
        descEl.style.display = 'block';
    } else {
        descEl.style.display = 'none';
    }
    
    // Time
    document.getElementById('recipeTime').textContent = recipe.time || '30 минут';
    
    // Ingredients
    const ingredientsList = document.getElementById('ingredientsList');
    ingredientsList.innerHTML = '';
    if (recipe.ingredients && recipe.ingredients.length > 0) {
        recipe.ingredients.forEach(ing => {
            const li = document.createElement('li');
            li.textContent = ing;
            ingredientsList.appendChild(li);
        });
    } else {
        ingredientsList.innerHTML = '<li>Ингредиенты не указаны</li>';
    }
    
    // Steps
    const stepsContainer = document.getElementById('stepsList');
    stepsContainer.innerHTML = '';
    if (recipe.steps && recipe.steps.length > 0) {
        recipe.steps.forEach((step, idx) => {
            const stepDiv = document.createElement('div');
            stepDiv.className = 'step-item';
            stepDiv.innerHTML = `
                <span class="step-number">${idx + 1}</span>
                <span class="step-text">${step}</span>
            `;
            stepsContainer.appendChild(stepDiv);
        });
    } else {
        stepsContainer.innerHTML = '<div class="step-item">Шаги приготовления не указаны</div>';
    }
    
    // Tips
    const tipsBlock = document.getElementById('tipsBlock');
    if (recipe.tips && recipe.tips.length > 0) {
        document.getElementById('tipsText').textContent = recipe.tips;
        tipsBlock.style.display = 'block';
    } else {
        tipsBlock.style.display = 'none';
    }
    
    // Nutrition (VIP)
    const nutritionBlock = document.getElementById('nutritionBlock');
    if (recipe.nutrition) {
        const nutritionContent = document.getElementById('nutritionContent');
        if (typeof recipe.nutrition === 'object') {
            nutritionContent.innerHTML = `
                <div class="nutrition-item"><span class="nutrition-label">🔥 Калории</span><span class="nutrition-value">${recipe.nutrition.calories || '—'}</span></div>
                <div class="nutrition-item"><span class="nutrition-label">🍗 Белки</span><span class="nutrition-value">${recipe.nutrition.protein || '—'}г</span></div>
                <div class="nutrition-item"><span class="nutrition-label">🍚 Жиры</span><span class="nutrition-value">${recipe.nutrition.fat || '—'}г</span></div>
                <div class="nutrition-item"><span class="nutrition-label">🌾 Углеводы</span><span class="nutrition-value">${recipe.nutrition.carbs || '—'}г</span></div>
            `;
        } else {
            nutritionContent.innerHTML = `<div class="nutrition-item">${recipe.nutrition}</div>`;
        }
        nutritionBlock.style.display = 'block';
    } else {
        nutritionBlock.style.display = 'none';
    }
    
    // Favorite button state
    const isFavorite = favorites.some(f => f.title === recipe.title);
    const favBtn = document.getElementById('favoriteBtn');
    if (isFavorite) {
        favBtn.classList.add('active');
    } else {
        favBtn.classList.remove('active');
    }
    
    showRecipe();
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Favorites
function saveToFavorites() {
    if (!currentRecipe) return;
    
    const index = favorites.findIndex(f => f.title === currentRecipe.title);
    if (index === -1) {
        favorites.push({ ...currentRecipe, savedAt: Date.now() });
        localStorage.setItem('chef_favorites', JSON.stringify(favorites));
        showToast('Рецепт сохранён в избранное', 'success');
        document.getElementById('favoriteBtn').classList.add('active');
    } else {
        favorites.splice(index, 1);
        localStorage.setItem('chef_favorites', JSON.stringify(favorites));
        showToast('Рецепт удалён из избранного', 'info');
        document.getElementById('favoriteBtn').classList.remove('active');
    }
}

function renderFavorites() {
    const container = document.getElementById('favoritesList');
    const emptyEl = document.getElementById('emptyFavorites');
    
    if (!favorites || favorites.length === 0) {
        container.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }
    
    emptyEl.style.display = 'none';
    container.innerHTML = favorites.map((recipe, idx) => `
        <div class="favorite-item" onclick="loadFavoriteRecipe(${idx})">
            <div>
                <div class="favorite-title">${escapeHtml(recipe.title)}</div>
                <div style="font-size: 12px; color: #999;">${recipe.time || '30 мин'}</div>
            </div>
            <button class="favorite-delete" onclick="event.stopPropagation(); deleteFavorite(${idx})">🗑️</button>
        </div>
    `).join('');
}

function loadFavoriteRecipe(index) {
    currentRecipe = favorites[index];
    displayRecipe(currentRecipe);
}

function deleteFavorite(index) {
    favorites.splice(index, 1);
    localStorage.setItem('chef_favorites', JSON.stringify(favorites));
    renderFavorites();
    showToast('Рецепт удалён', 'info');
}

// Profile
function updateProfile() {
    if (!currentUser) return;
    
    const firstName = tg.initDataUnsafe.user?.first_name || 'Пользователь';
    document.getElementById('profileName').textContent = firstName;
    document.getElementById('profileUsername').textContent = '@' + (tg.initDataUnsafe.user?.username || 'user');
    
    const subStatus = document.getElementById('subStatus');
    const freeRecipesRow = document.getElementById('freeRecipesRow');
    const expiresRow = document.getElementById('expiresRow');
    
    if (currentUser.hasSubscription) {
        subStatus.textContent = currentUser.subscription.plan_type;
        subStatus.style.color = 'var(--primary)';
        freeRecipesRow.style.display = 'none';
        if (currentUser.subscription.expires_at) {
            expiresRow.style.display = 'flex';
            document.getElementById('expiresDate').textContent = new Date(currentUser.subscription.expires_at).toLocaleDateString('ru-RU');
        }
    } else {
        subStatus.textContent = 'Бесплатный';
        subStatus.style.color = 'var(--gray)';
        freeRecipesRow.style.display = 'flex';
        document.getElementById('freeRecipesLeft').textContent = `${currentUser.freeRecipesLeft}/${currentUser.freeLimit || 3}`;
        expiresRow.style.display = 'none';
    }
    
    // Stats
    document.getElementById('totalRecipes').textContent = '0'; // Would need backend tracking
    document.getElementById('favoritesCount').textContent = favorites.length;
}

// Subscription & Payment
function showSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    modal.style.display = 'flex';
}

function hideSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    modal.style.display = 'none';
}

async function handlePayment(planType) {
    const amount = planType === 'PRO' ? 500 : 800;
    
    try {
        const response = await fetch('/api/create-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tgId: tg.initDataUnsafe.user.id,
                planType: planType,
                amount: amount
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentPaymentId = data.paymentId;
            currentPlanType = planType;
            
            document.getElementById('paymentPlanBadge').textContent = `${planType} — ${amount}₽`;
            document.getElementById('sbpNumber').textContent = data.sbpPhone;
            document.getElementById('sbpName').textContent = data.sbpRecipient;
            
            hideSubscriptionModal();
            const paymentModal = document.getElementById('paymentModal');
            paymentModal.style.display = 'flex';
        }
    } catch (error) {
        showToast('Ошибка создания платежа', 'error');
    }
}

async function submitReceipt(file) {
    if (!currentPaymentId) return;
    
    const formData = new FormData();
    formData.append('receipt', file);
    formData.append('tgId', tg.initDataUnsafe.user.id);
    formData.append('paymentId', currentPaymentId);
    formData.append('planType', currentPlanType);
    formData.append('amount', currentPlanType === 'PRO' ? 500 : 800);
    
    try {
        const response = await fetch('/api/upload-receipt', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Чек отправлен! Ожидайте подтверждения', 'success');
            document.getElementById('paymentModal').style.display = 'none';
            currentPaymentId = null;
            currentPlanType = null;
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        showToast('Ошибка отправки чека', 'error');
    }
}

// Voice recording
async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice.webm');
            
            showToast('🎤 Распознаю голос...', 'info');
            
            try {
                const response = await fetch('/api/transcribe', {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();
                if (data.success && data.text) {
                    recipeInput.value = data.text;
                    showToast('✅ Голос распознан!', 'success');
                } else {
                    showToast('Не удалось распознать, попробуйте ещё раз', 'error');
                }
            } catch (error) {
                showToast('Ошибка распознавания', 'error');
            }
            
            stream.getTracks().forEach(track => track.stop());
            voiceBtn.classList.remove('recording');
        };
        
        mediaRecorder.start();
        voiceBtn.classList.add('recording');
        showToast('🎤 Говорите... Нажмите снова для остановки', 'info');
    } catch (error) {
        showToast('Нет доступа к микрофону', 'error');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
}

// Share recipe
async function shareRecipe() {
    if (!currentRecipe) return;
    
    const shareText = `🍽 *${currentRecipe.title}*\n\n` +
        `🥄 Ингредиенты:\n${(currentRecipe.ingredients || []).map(i => `• ${i}`).join('\n')}\n\n` +
        `🔥 Приготовление:\n${(currentRecipe.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
        `✨ Приятного аппетита!`;
    
    if (navigator.share) {
        try {
            await navigator.share({
                title: currentRecipe.title,
                text: shareText
            });
        } catch(e) {}
    } else {
        await navigator.clipboard.writeText(shareText);
        showToast('Рецепт скопирован в буфер обмена!', 'success');
    }
}

// Save as image (using html2canvas if available)
async function saveAsImage() {
    showToast('Функция сохранения изображения в разработке', 'info');
}

// Helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event listeners
document.addEventListener('DOMContentLoaded', async () => {
    await getUserData();
    
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            if (page === 'home') {
                showWelcome();
            } else if (page === 'favorites') {
                showFavorites();
            } else if (page === 'profile') {
                showProfile();
            }
        });
    });
    
    // Generate button
    generateBtn.addEventListener('click', () => {
        const query = recipeInput.value.trim();
        if (!query) {
            showToast('Напишите, что хотите приготовить', 'info');
            return;
        }
        pendingQuery = query;
        detailsSection.style.display = 'block';
        detailsInput.focus();
    });
    
    // Voice button
    voiceBtn.addEventListener('click', () => {
        if (voiceBtn.classList.contains('recording')) {
            stopRecording();
        } else {
            startRecording();
        }
    });
    
    // Submit details
    submitDetailsBtn.addEventListener('click', async () => {
        const details = detailsInput.value.trim();
        detailsSection.style.display = 'none';
        await generateRecipe(pendingQuery, details);
        detailsInput.value = '';
    });
    
    // Quick options
    document.querySelectorAll('.quick-option').forEach(btn => {
        btn.addEventListener('click', () => {
            detailsInput.value = btn.dataset.detail;
        });
    });
    
    // Favorite button
    document.getElementById('favoriteBtn')?.addEventListener('click', saveToFavorites);
    
    // Share button
    document.getElementById('shareBtn')?.addEventListener('click', shareRecipe);
    
    // Save image button
    document.getElementById('saveImageBtn')?.addEventListener('click', saveAsImage);
    
    // New recipe button
    document.getElementById('newRecipeBtn')?.addEventListener('click', () => {
        showWelcome();
        recipeInput.value = '';
        currentRecipe = null;
    });
    
    // Upgrade button
    document.getElementById('upgradeBtn')?.addEventListener('click', showSubscriptionModal);
    
    // Subscription modal
    document.querySelector('.close-modal')?.addEventListener('click', hideSubscriptionModal);
    document.querySelector('.modal-overlay')?.addEventListener('click', hideSubscriptionModal);
    
    document.querySelectorAll('.select-plan-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const plan = e.target.closest('.plan-card').dataset.plan;
            handlePayment(plan);
        });
    });
    
    // Payment modal
    document.querySelector('.close-payment-modal')?.addEventListener('click', () => {
        document.getElementById('paymentModal').style.display = 'none';
    });
    
    document.querySelector('.cancel-payment')?.addEventListener('click', () => {
        document.getElementById('paymentModal').style.display = 'none';
    });
    
    document.getElementById('copySbpBtn')?.addEventListener('click', () => {
        const number = document.getElementById('sbpNumber').textContent;
        navigator.clipboard.writeText(number);
        showToast('Номер скопирован!', 'success');
    });
    
    document.getElementById('receiptInput')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const preview = document.getElementById('receiptPreview');
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            preview.innerHTML = '';
            preview.appendChild(img);
            document.querySelector('.submit-payment').disabled = false;
        }
    });
    
    document.querySelector('.submit-payment')?.addEventListener('click', () => {
        const file = document.getElementById('receiptInput').files[0];
        if (!file) {
            showToast('Выберите чек', 'info');
            return;
        }
        submitReceipt(file);
    });
});

// Telegram theme adaptation
if (tg.colorScheme === 'dark') {
    document.body.classList.add('dark');
}
