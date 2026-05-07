const { getXMentions, getKOLMentions } = require('./x-scanner');

async function computeViralityVelocity(tokenAddress, symbol) {
  const query = `$${symbol} OR "${symbol} coin" OR "${symbol} token"`;

  const [m15, m30, m60, m180] = await Promise.all([
    getXMentions(query, 15),
    getXMentions(query, 30),
    getXMentions(query, 60),
    getXMentions(query, 180)
  ]);

  const velocity15to30 = m15 > 0 ? (m30 - m15) / m15 : 0;
  const velocity30to60 = m30 > 0 ? (m60 - m30) / m30 : 0;
  const isExponential = velocity15to30 > 0.5 && velocity30to60 > velocity15to30;

  const kolMentions = await getKOLMentions(query, 60);
  const kolScore = Math.min(30, kolMentions * 5);

  let socialScore = 0;
  socialScore += Math.min(40, m60 * 0.5);
  socialScore += isExponential ? 30 : 0;
  socialScore += kolScore;

  return {
    socialScore: Math.min(100, Math.round(socialScore)),
    mentionsLastHour: m60,
    viralityVelocity: velocity30to60,
    isExponential,
    kolMentions,
    isViral: socialScore > 65
  };
}

module.exports = { computeViralityVelocity };