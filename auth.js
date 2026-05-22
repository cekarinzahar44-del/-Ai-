const crypto = require('crypto');

function validateTelegramAuth(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    const entries = [];
    for (const [k, v] of params.entries()) {
      if (k !== 'hash') entries.push(`${k}=${v}`);
    }
    entries.sort();
    const dataCheckString = entries.join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const checkHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (checkHash !== hash) return null;

    const authDate = parseInt(params.get('auth_date'));
    if (Date.now() / 1000 - authDate > 86400) return null;

    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

module.exports = { validateTelegramAuth };
