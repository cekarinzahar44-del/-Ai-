const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
}

const initData = tg?.initData || '';

// ===== АББРЕВИАТУРЫ ДЛЯ TTS =====
const abbrMap = {
  'шт\\b': 'штук', 'шт\\.\\b': 'штук',
  'г\\b': 'грамм', 'г\\.\\b': 'грамм',
  'мл\\b': 'миллилитров',
  'кг\\b': 'килограмм',
  'ч\\.л\\.?\\b': 'чайной ложки',
  'ст\\.л\\.?\\b': 'столовой ложки',
  'мин\\b': 'минут', 'мин\\.\\b': 'минут',
  'сек\\b': 'секунд',
  '°C': 'градусов Цельсия',
  '°': 'градусов'
};

const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

function prepareForTTS(text) {
  if (!text) return '';
  let clean = text
    .replace(/<[^>]+>/g, '')
    .replace(emojiRegex, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [abbr, full] of Object.entries(abbrMap)) {
    clean = clean.replace(new RegExp(abbr, 'gi'), full);
  }
  return clean.length > 4000 ? clean.substring(0, 4000) + '...' : clean;
}

// ===== API =====
const API = {
  async request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'x-telegram-init-data': initData,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  },
  getStatus: () => API.request('/api/recipe/status'),
  generateRecipe: (ingredients, details) => API.request('/api/recipe/generate', {
    method: 'POST',
    body: JSON.stringify({ ingredients, details })
  }),
  getPaymentInfo: () => API.request('/api/payment/info'),
  getFullProfile: () => API.request('/api/user/fullprofile'),
  generateWeekMenu: (prefs) => API.request('/api/vip/weekmenu', {
    method: 'POST',
    body: JSON.stringify({ prefs })
  }),
  askDiet: (question) => API.request('/api/vip/diet', {
    method: 'POST',
    body: JSON.stringify({ question })
  }),
  recognizeVoice: async (blob) => {
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    const res = await fetch('/api/stt/recognize', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
    return res.json();
  },
  uploadReceipt: async (file, planType) => {
    const fd = new FormData();
    fd.append('receipt', file);
    fd.append('planType', planType);
    const res = await fetch('/api/payment/upload', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData },
      body: fd
    });
    return res.json();
  }
};

// ===== VOICE (запись + озвучка) =====
const Voice = {
  mediaRecorder: null,
  chunks: [],
  isRecording: false,
  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      return true;
    } catch (e) {
      alert('Нет доступа к микрофону');
      return false;
    }
  },
  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve('');
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        try {
          const data = await API.recognizeVoice(blob);
          resolve(data.text || '');
        } catch (e) { resolve(''); }
      };
      this.mediaRecorder.stop();
    });
  },
  speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const clean = prepareForTTS(text);
    if (!clean) return;
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'ru-RU';
    utter.rate = 1;
    window.speechSynthesis.speak(utter);
  },
  stop() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }
};

// ===== ГОЛОСОВАЯ НАВИГАЦИЯ =====
const VoiceNav = {
  isListening: false,
  recognition: null,
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Голосовое управление не поддерживается'); return; }    this.recognition = new SR();
    this.recognition.lang = 'ru-RU';
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.onresult = (e) => {
      const text = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      console.log('🎤', text);
      this.handleCommand(text);
    };
    this.recognition.onerror = (e) => console.error('Voice nav error:', e);
    this.recognition.onend = () => {
      if (this.isListening) this.recognition.start();
    };
    this.recognition.start();
    this.isListening = true;
  },
  stop() {
    this.isListening = false;
    if (this.recognition) this.recognition.stop();
  },
  handleCommand(text) {
    if (!RecipeManager.current) return;
    if (/следующий|дальше|далее|вперёд/i.test(text)) {
      RecipeManager.next();
    } else if (/назад|предыдущий|прошлый/i.test(text)) {
      RecipeManager.prev();
    } else if (/первый|начало/i.test(text)) {
      RecipeManager.step = 0;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[0]);
    } else if (/второй/i.test(text)) {
      RecipeManager.step = 1;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[1]);
    } else if (/третий/i.test(text)) {
      RecipeManager.step = 2;
      RecipeManager.render();
      Voice.speak(RecipeManager.current.steps[2]);
    } else if (/повтори|озвуч|читать|произнеси/i.test(text)) {
      Voice.speak(RecipeManager.current.steps[RecipeManager.step]);
    } else if (/стоп|выход|закрыть|хватит/i.test(text)) {
      showScreen('home');
    }
  }
};

// ===== RECIPE MANAGER =====
const RecipeManager = {
  current: null,
  step: 0,  load(recipe) {
    this.current = recipe;
    this.step = 0;
    this.render();
  },
  render() {
    if (!this.current) return;
    document.getElementById('recipe-title').innerHTML = this.current.title;
    document.getElementById('step-total').textContent = this.current.total;
    document.getElementById('step-current').textContent = this.step + 1;
    document.getElementById('step-text').innerHTML = this.current.steps[this.step];
    document.getElementById('btn-prev').disabled = this.step === 0;
    document.getElementById('btn-next').textContent =
      this.step === this.current.total - 1 ? '🏁 Готово' : 'Далее ➡️';
  },
  next() {
    if (!this.current) return;
    if (this.step < this.current.total - 1) {
      this.step++;
      this.render();
      Voice.speak(this.current.steps[this.step]);
    } else showScreen('home');
  },
  prev() {
    if (this.step > 0) {
      this.step--;
      this.render();
      Voice.speak(this.current.steps[this.step]);
    }
  }
};

// ===== STATE =====
const state = { ingredients: '', prefs: [], planToBuy: null };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  Voice.stop();
  VoiceNav.stop();
  const navBtn = document.getElementById('btn-voice-nav');
  if (navBtn) {
    navBtn.classList.remove('recording');
    navBtn.textContent = '🎤';
  }
  tg?.HapticFeedback?.impactOccurred('light');
  if (name === 'profile') loadProfile();
}

// ===== INIT =====async function init() {
  try {
    const status = await API.getStatus();
    const badge = document.getElementById('user-badge');
    const freeCount = document.getElementById('free-count');
    if (status.subscription) {
      badge.textContent = status.subscription.plan_type;
      freeCount.textContent = '✨ Безлимит';
    } else {
      badge.textContent = 'FREE';
      const left = Math.max(0, status.freeLimit - status.freeUsed);
      freeCount.textContent = `Осталось: ${left} из ${status.freeLimit}`;
    }
  } catch (e) {
    console.error('Init:', e);
    document.getElementById('free-count').textContent = 'Ошибка';
  }
}

// ===== EVENT LISTENERS =====
document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => {
    document.getElementById('dish-input').value = c.dataset.dish;
    tg?.HapticFeedback?.impactOccurred('light');
  });
});

document.querySelectorAll('.pref').forEach(p => {
  p.addEventListener('click', () => {
    p.classList.toggle('active');
    const v = p.dataset.pref;
    if (state.prefs.includes(v)) state.prefs = state.prefs.filter(x => x !== v);
    else state.prefs.push(v);
    tg?.HapticFeedback?.impactOccurred('light');
  });
});

document.getElementById('btn-send').addEventListener('click', () => {
  const val = document.getElementById('dish-input').value.trim();
  if (!val) {
    tg?.HapticFeedback?.notificationOccurred('error');
    return;
  }
  state.ingredients = val;
  showScreen('details');
});

document.getElementById('btn-voice').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!Voice.isRecording) {    const ok = await Voice.startRecording();
    if (ok) {
      btn.classList.add('recording');
      btn.textContent = '⏹';
      tg?.HapticFeedback?.impactOccurred('medium');
    }
  } else {
    btn.classList.remove('recording');
    btn.textContent = '🎤';
    const text = await Voice.stopRecording();
    if (text) {
      document.getElementById('dish-input').value = text;
      tg?.HapticFeedback?.notificationOccurred('success');
    }
  }
});

document.getElementById('btn-generate').addEventListener('click', async () => {
  const portions = document.getElementById('portions').value;
  const extra = document.getElementById('extra-details').value;
  const details = `${portions} порций. ${state.prefs.join(', ')}. ${extra}`.trim();
  showScreen('loading');
  tg?.HapticFeedback?.impactOccurred('light');
  try {
    const recipe = await API.generateRecipe(state.ingredients, details);
    RecipeManager.load(recipe);
    showScreen('recipe');
    Voice.speak(recipe.steps[0]);
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (e) {
    if (e.message.includes('limit_reached')) showScreen('subscription');
    else {
      alert('Ошибка: ' + e.message);
      showScreen('home');
    }
  }
});

document.getElementById('btn-next').addEventListener('click', () => RecipeManager.next());
document.getElementById('btn-prev').addEventListener('click', () => RecipeManager.prev());
document.getElementById('btn-voice-read').addEventListener('click', () => {
  if (RecipeManager.current) Voice.speak(RecipeManager.current.steps[RecipeManager.step]);
});
document.getElementById('btn-full-recipe').addEventListener('click', () => {
  if (!RecipeManager.current) return;
  const full = RecipeManager.current.steps.map((s, i) => `Шаг ${i+1}: ${s}`).join('\n\n');
  alert(RecipeManager.current.title.replace(/<[^>]+>/g, '') + '\n\n' + full.replace(/<[^>]+>/g, ''));
});

// Голосовая навигацияdocument.getElementById('btn-voice-nav').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!VoiceNav.isListening) {
    VoiceNav.start();
    btn.classList.add('recording');
    btn.textContent = '🎙';
    tg?.HapticFeedback?.impactOccurred('medium');
  } else {
    VoiceNav.stop();
    btn.classList.remove('recording');
    btn.textContent = '🎤';
  }
});

// ===== ОПЛАТА =====
window.buyPlan = async (plan) => {
  state.planToBuy = plan;
  try {
    const info = await API.getPaymentInfo();
    document.getElementById('sbp-phone').textContent = info.sbpPhone;
    document.getElementById('sbp-recipient').textContent = info.recipient;
    document.getElementById('pay-amount').textContent = info.prices[plan];
    showScreen('payment');
  } catch (e) { alert('Ошибка: ' + e.message); }
};

document.getElementById('btn-upload-receipt').addEventListener('click', async () => {
  const file = document.getElementById('receipt-file').files[0];
  if (!file) return alert('Выберите файл');
  try {
    const res = await API.uploadReceipt(file, state.planToBuy);
    alert(`✅ Чек принят!\n📋 Заявка #${res.paymentId}\nОжидайте подтверждения.`);
    showScreen('home');
    init();
  } catch (e) { alert('Ошибка: ' + e.message); }
});

// ===== VIP: WEEK MENU =====
document.getElementById('btn-generate-weekmenu').addEventListener('click', async () => {
  const prefs = document.getElementById('weekmenu-prefs').value;
  const btn = document.getElementById('btn-generate-weekmenu');
  btn.disabled = true;
  btn.textContent = '⏳ Составляю...';
  try {
    const data = await API.generateWeekMenu(prefs);
    document.getElementById('weekmenu-text').innerHTML = data.menu.replace(/\n/g, '<br>');
    document.getElementById('weekmenu-result').style.display = 'block';
  } catch (e) {
    if (e.message.includes('Только для VIP')) {
      alert('🔒 Эта функция доступна только с VIP подпиской');      showScreen('subscription');
    } else {
      alert('Ошибка: ' + e.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Составить меню';
  }
});

// ===== VIP: DIET =====
document.getElementById('btn-ask-diet').addEventListener('click', async () => {
  const question = document.getElementById('diet-question').value.trim();
  if (!question) return alert('Задай вопрос');
  const btn = document.getElementById('btn-ask-diet');
  btn.disabled = true;
  btn.textContent = '⏳ Думаю...';
  try {
    const data = await API.askDiet(question);
    document.getElementById('diet-text').innerHTML = data.answer.replace(/\n/g, '<br>');
    document.getElementById('diet-result').style.display = 'block';
  } catch (e) {
    if (e.message.includes('Только для VIP')) {
      alert('🔒 Эта функция доступна только с VIP подпиской');
      showScreen('subscription');
    } else {
      alert('Ошибка: ' + e.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '💬 Спросить';
  }
});

// ===== PROFILE =====
async function loadProfile() {
  try {
    const data = await API.getFullProfile();
    document.getElementById('profile-name').textContent = data.user?.first_name || 'Пользователь';
    document.getElementById('profile-username').textContent = data.user?.username ? '@' + data.user.username : '';
    document.getElementById('stat-recipes').textContent = data.user?.free_recipes_used || 0;
    document.getElementById('stat-plan').textContent = data.subscription?.plan_type || 'FREE';
    document.getElementById('stat-expires').textContent = data.subscription 
      ? new Date(data.subscription.expires_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
      : '—';
  } catch (e) {
    console.error('Profile error:', e);
  }
}
init();
