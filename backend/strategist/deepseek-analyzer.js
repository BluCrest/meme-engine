const config = require('../config');
const db = require('../database/db');

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

async function callDeepSeek(prompt, maxTokens = 800) {
  try {
    const res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.deepseek.apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(`DeepSeek API error: ${error.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error('[DeepSeek] API call failed:', err.message);
    throw err;
  }
}

function cleanJSONResponse(raw) {
  return raw.replace(/```json|```/g, '').trim();
}

async function analyzeTokenRealTime(tokenData) {
  const recentPatterns = await db.getDb().collection('deepseek_patterns')
    .find({}, { sort: { updated_at: -1 }, limit: 20 }).toArray();

  const prompt = `You are a memecoin intelligence analyst with deep reasoning capabilities. Analyze this token comprehensively.

TOKEN DATA:
${JSON.stringify(tokenData, null, 2)}

HISTORICAL PATTERNS FROM DATABASE:
${JSON.stringify(recentPatterns, null, 2)}

INSTRUCTIONS:
- Cross-reference current token data with historical patterns
- Consider dev reputation in context of current market conditions
- Factor in momentum divergence as a leading indicator
- Weight safety score heavily if honeypot detected
- Consider cross-chain rug history as a severe red flag
- Analyze if virality velocity is organic or artificially pumped
- Provide nuanced reasoning that connects multiple data points

RESPOND ONLY IN JSON (no markdown, no code blocks):
{
  "ape_probability": <0-100 integer>,
  "moonshot_probability": <0-100 integer>,
  "absolute_moonshot_probability": <0-100 integer>,
  "risk_level": "<low|medium|high|extreme>",
  "key_signals": ["<specific signal with context>", "<signal>"],
  "red_flags": ["<specific flag with evidence>", "<flag>"],
  "suggested_entry_mc": <number or null>,
  "suggested_exit_targets": [<2x>, <5x>, <10x>] or null,
  "reasoning": "<2-3 sentence synthesis connecting dev history, current momentum, safety, and social signals>",
  "confidence": <0-100 integer>,
  "pattern_match": "<name of matching historical pattern if any>",
  "secondary_signals": ["<subtle indicator>"]
}`;

  try {
    const raw = await callDeepSeek(prompt, 1000);
    return JSON.parse(cleanJSONResponse(raw));
  } catch (err) {
    console.error('[DeepSeek] Real-time analysis failed:', err.message);
    return {
      ape_probability: 0,
      moonshot_probability: 0,
      absolute_moonshot_probability: 0,
      risk_level: 'extreme',
      key_signals: [],
      red_flags: ['Analysis failed'],
      suggested_entry_mc: null,
      suggested_exit_targets: null,
      reasoning: 'DeepSeek analysis unavailable',
      confidence: 0
    };
  }
}

async function weeklyRetro() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const trades = await db.getDb().collection('trades')
    .find({ timestamp: { $gte: oneWeekAgo } }).toArray();

  const reports = await db.getDb().collection('intelligence_reports')
    .find({}, { sort: { timestamp: -1 }, limit: 50 }).toArray();

  const patterns = await db.getDb().collection('deepseek_patterns')
    .find({}, { sort: { updated_at: -1 } }).toArray();

  const prompt = `You are analyzing a memecoin trading system's weekly performance. Provide DEEP synthesis.

TRADE OUTCOMES THIS WEEK (${trades.length} trades):
${JSON.stringify(trades, null, 2)}

INTELLIGENCE REPORTS (${reports.length} reports):
${JSON.stringify(reports, null, 2)}

EXISTING PATTERN LIBRARY (${patterns.length} patterns):
${JSON.stringify(patterns, null, 2)}

DEEP ANALYSIS REQUIRED:
1. WIN patterns: What combination of safety/social/smart money scores consistently led to wins? What was the dev profile of winning trades?
2. LOSS patterns: What were the early warning signs that were missed? Were there divergence signals before losses?
3. Edge cases: Any surprise wins/losses that defy the normal patterns?
4. Coefficient tuning: Based on actual outcomes, how should we weight each factor?
5. Novel patterns: Identify 3-5 NEW patterns from this week's data that aren't in our library.

RESPOND ONLY IN JSON:
{
  "win_patterns": [
    { "pattern": "<description>", "score_profile": {}, "sample_size": 0, "win_rate": 0.0 }
  ],
  "loss_patterns": [
    { "pattern": "<description>", "score_profile": {}, "sample_size": 0, "loss_rate": 0.0 }
  ],
  "coefficient_suggestions": {
    "safety_weight": <0.0-1.0>,
    "social_weight": <0.0-1.0>,
    "smart_money_weight": <0.0-1.0>,
    "dev_reputation_weight": <0.0-1.0>
  },
  "new_patterns": [
    {
      "name": "<pattern name>",
      "description": "<detailed description>",
      "conditions": { "safety_score_min": 0, "social_score_min": 0 },
      "estimated_win_rate": <0.0-1.0>,
      "sample_size": 0
    }
  ],
  "summary": "<2-3 sentence deep synthesis of weekly performance>",
  "recommendations": ["<actionable recommendation>"]
}`;

  try {
    const raw = await callDeepSeek(prompt, 2000);
    const result = JSON.parse(cleanJSONResponse(raw));

    // Save new patterns to DB
    if (result.new_patterns?.length) {
      await db.getDb().collection('deepseek_patterns').insertMany(
        result.new_patterns.map(p => ({
          ...p,
          created_at: new Date(),
          updated_at: new Date()
        }))
      );
    }

    // Save retro report
    await db.getDb().collection('weekly_retro').insertOne({
      ...result,
      week_of: oneWeekAgo,
      created_at: new Date()
    });

    return result;
  } catch (err) {
    console.error('[DeepSeek] Weekly retro failed:', err.message);
    return null;
  }
}

async function analyzeLossPattern(tokenAddress) {
  const reports = await db.getDb().collection('intelligence_reports')
    .find({ token_address: tokenAddress }).toArray();

  if (!reports.length) return null;

  const prompt = `Analyze this loss in deep context. What combination of signals should have predicted this outcome?

LOSS REPORT:
${JSON.stringify(reports, null, 2)}

RESPOND ONLY IN JSON:
{
  "predicted_by": ["<which signals should have caught this>"],
  "missed_signals": ["<what we failed to check>"],
  "pattern_name": "<name this anti-pattern>",
  "avoidance_rules": ["<rule to prevent future losses>"]
}`;

  try {
    const raw = await callDeepSeek(prompt, 800);
    return JSON.parse(cleanJSONResponse(raw));
  } catch (err) {
    console.error('[DeepSeek] Loss analysis failed:', err.message);
    return null;
  }
}

module.exports = {
  analyzeTokenRealTime,
  weeklyRetro,
  analyzeLossPattern,
  callDeepSeek
};