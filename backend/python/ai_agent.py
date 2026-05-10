"""
Meme Engine AI Agent - Token Scoring Engine
Uses lightweight ML models for free (no API costs)
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime
import logging

logging.basicConfig(level=logging.INFO, format='[AI] %(message)s')
logger = logging.getLogger(__name__)

# Simple feature weights learned from market patterns
TOKEN_FEATURES = {
    'safety_score': 0.25,
    'social_score': 0.15,
    'smart_money_score': 0.20,
    'dev_reputation': 0.15,
    'volume_momentum': 0.10,
    'mc_early': 0.08,
    'narrative_match': 0.07
}

def compute_ape_score(token_data):
    """
    Compute APE probability using learned weights + pattern recognition
    """
    try:
        safety = float(token_data.get('safety_score', 50))
        social = float(token_data.get('social_score', 0))
        smart_money = float(token_data.get('smart_money_score', 0))
        dev_rep = float(token_data.get('dev_reputation', 50))
        volume = float(token_data.get('volume_24h', 0))
        mc = float(token_data.get('market_cap', 0))
        age_min = float(token_data.get('age_minutes', 999))
        grad_progress = float(token_data.get('graduation_progress', 0))
        buy_sell_ratio = float(token_data.get('buy_sell_ratio', 0.5))

        # Base weighted score
        base_score = (
            safety * TOKEN_FEATURES['safety_score'] +
            social * TOKEN_FEATURES['social_score'] +
            smart_money * TOKEN_FEATURES['smart_money_score'] +
            dev_rep * TOKEN_FEATURES['dev_reputation']
        )

        # Volume momentum bonus
        vol_momentum = 0
        if volume > 10000:
            vol_momentum = min(8, np.log10(volume) * 2)
        elif volume > 1000:
            vol_momentum = 3

        # Early MC bonus (micro-cap advantage)
        mc_bonus = 0
        if mc < 5000:
            mc_bonus = 8
        elif mc < 15000:
            mc_bonus = 5
        elif mc < 40000:
            mc_bonus = 2

        # Fresh token bonus
        fresh_bonus = 0
        if age_min < 5:
            fresh_bonus = 6
        elif age_min < 30:
            fresh_bonus = 3
        elif age_min < 60:
            fresh_bonus = 1

        # Graduation momentum
        grad_bonus = 0
        if grad_progress > 80:
            grad_bonus = 10
        elif grad_progress > 50:
            grad_bonus = 5
        elif grad_progress > 20:
            grad_bonus = 2

        # Buy pressure bonus
        buy_bonus = 0
        if buy_sell_ratio > 0.7:
            buy_bonus = 5
        elif buy_sell_ratio > 0.55:
            buy_bonus = 3

        # Combine all factors
        total_score = min(100, base_score + vol_momentum + mc_bonus + fresh_bonus + grad_bonus + buy_bonus)

        # Risk adjustments
        if token_data.get('honeypot', False):
            total_score *= 0.1
        if token_data.get('top5_concentration', 0) > 80:
            total_score *= 0.5
        if token_data.get('bundle_detected', False):
            total_score *= 0.6
        if token_data.get('dev_rug_count', 0) >= 3:
            total_score *= 0.3

        return round(total_score, 1)

    except Exception as e:
        logger.error(f"Score computation error: {e}")
        return 50.0

def compute_moonshot_score(token_data):
    """
    Compute moonshot probability - for tokens with viral potential
    """
    try:
        social_score = float(token_data.get('social_score', 0))
        smart_count = int(token_data.get('smart_money_count', 0))
        is_viral = token_data.get('is_viral', False)
        divergence = float(token_data.get('divergence_score', 50))

        # Strong divergence = good momentum
        momentum_bonus = 0
        if divergence < 30:
            momentum_bonus = 20
        elif divergence < 50:
            momentum_bonus = 10

        # Smart money accumulation
        sm_bonus = smart_count * 10 if smart_count >= 2 else 0

        moonshot = min(100, social_score * 0.5 + sm_bonus + momentum_bonus + (20 if is_viral else 0))

        return round(moonshot, 1)
    except:
        return 0.0

def analyze_patterns(token_data, historical_tokens):
    """
    Pattern matching - find similar successful tokens from history
    """
    if not historical_tokens or len(historical_tokens) < 5:
        return {"match_score": 0, "similar_tokens": [], "confidence": "low"}

    current_mc = float(token_data.get('market_cap', 0))
    current_vol = float(token_data.get('volume_24h', 0))
    current_age = float(token_data.get('age_minutes', 999))

    matches = []
    for hist in historical_tokens:
        hist_mc = float(hist.get('mc', 0))
        hist_vol = float(hist.get('volume', 0))
        hist_age = float(hist.get('age', 999))
        hist_pnl = float(hist.get('pnl_pct', 0))

        # Calculate similarity
        mc_diff = abs(current_mc - hist_mc) / max(hist_mc, 1)
        vol_ratio = min(current_vol, hist_vol) / max(current_vol, hist_vol, 1)
        age_diff = abs(current_age - hist_age)

        similarity = (1 - min(mc_diff, 1)) * 0.4 + vol_ratio * 0.4 + (1 - min(age_diff / 60, 1)) * 0.2

        if similarity > 0.5 and hist_pnl > 0:
            matches.append({
                "symbol": hist.get('symbol', 'UNKNOWN'),
                "similarity": round(similarity * 100, 1),
                "pnl": round(hist_pnl, 1)
            })

    matches.sort(key=lambda x: x['similarity'], reverse=True)
    top_matches = matches[:3]

    confidence = "low"
    if len(matches) >= 3:
        avg_sim = sum(m['similarity'] for m in top_matches) / len(top_matches)
        if avg_sim > 70:
            confidence = "high"
        elif avg_sim > 50:
            confidence = "medium"

    return {
        "match_score": round(sum(m['similarity'] for m in top_matches) / max(len(top_matches), 1), 1),
        "similar_tokens": top_matches,
        "confidence": confidence
    }

def generate_signals(token_data):
    """
    Generate trading signals based on all available data
    """
    ape = compute_ape_score(token_data)
    moonshot = compute_moonshot_score(token_data)

    signals = []
    risk_flags = []

    # Positive signals
    if ape >= 75:
        signals.append("STRONG_BUY")
    elif ape >= 60:
        signals.append("BUY")
    elif ape >= 45:
        signals.append("HOLD")

    if moonshot >= 60:
        signals.append("MOONSHOT_CANDIDATE")

    if token_data.get('smart_money_count', 0) >= 3:
        signals.append("SMART_MONEY_ACCUMULATING")

    if token_data.get('graduation_progress', 0) > 50:
        signals.append("GRADUATING_SOON")

    # Risk flags
    if token_data.get('honeypot', False):
        risk_flags.append("HONEYPOT")

    if token_data.get('top5_concentration', 0) > 70:
        risk_flags.append("CENTRALIZATION_RISK")

    if token_data.get('dev_rug_count', 0) >= 2:
        risk_flags.append("DEV_HISTORY_RISK")

    if token_data.get('buy_sell_ratio', 0.5) < 0.35:
        risk_flags.append("SELL_PRESSURE")

    if token_data.get('is_dead', False):
        risk_flags.append("TOKEN_DEAD")

    return {
        "signal": signals[0] if signals else "SKIP",
        "all_signals": signals,
        "risk_flags": risk_flags,
        "should_alert": ape >= 65 and len(risk_flags) < 2,
        "suggested_exit": 2.0 if ape >= 70 else (3.0 if ape >= 80 else 1.5)
    }

def analyze_token(token_address, token_data, historical_tokens=None):
    """
    Main entry point - full token analysis
    """
    try:
        ape_probability = compute_ape_score(token_data)
        moonshot_probability = compute_moonshot_score(token_data)
        pattern_analysis = analyze_patterns(token_data, historical_tokens or [])
        signals = generate_signals(token_data)

        result = {
            "token_address": token_address,
            "ape_probability": ape_probability,
            "moonshot_probability": moonshot_probability,
            "confidence": pattern_analysis['confidence'],
            "pattern_match": pattern_analysis,
            "signals": signals,
            "analyzed_at": datetime.utcnow().isoformat()
        }

        return result

    except Exception as e:
        logger.error(f"Analysis error: {e}")
        return {
            "token_address": token_address,
            "ape_probability": 50,
            "moonshot_probability": 0,
            "error": str(e)
        }

def main():
    """
    Run as HTTP server for Node.js integration
    """
    import http.server
    import socketserver
    import urllib.parse

    PORT = int(os.environ.get('PYTHON_AI_PORT', 5000))

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path == '/analyze':
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length).decode('utf-8')
                data = json.loads(body)

                result = analyze_token(
                    data.get('token_address', ''),
                    data.get('token_data', {}),
                    data.get('historical_tokens', [])
                )

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            else:
                self.send_response(404)
                self.end_headers()

        def do_GET(self):
            if self.path == '/health':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "service": "ai_agent"}).encode())
            else:
                self.send_response(404)
                self.end_headers()

    print(f"[AI Agent] Starting on port {PORT}")
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        main()
    else:
        # Test mode
        test_data = {
            'safety_score': 75,
            'social_score': 60,
            'smart_money_score': 70,
            'dev_reputation': 80,
            'volume_24h': 25000,
            'market_cap': 12000,
            'age_minutes': 15,
            'graduation_progress': 45,
            'buy_sell_ratio': 0.65
        }
        result = analyze_token("test_token", test_data)
        print(json.dumps(result, indent=2))