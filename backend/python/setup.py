#!/usr/bin/env python3
"""
Meme Engine Python Setup
Install dependencies and verify environment
"""

import subprocess
import sys
import os

def install_requirements():
    print("[Setup] Installing Python dependencies...")
    req_file = os.path.join(os.path.dirname(__file__), 'requirements.txt')

    try:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-r', req_file])
        print("[Setup] Dependencies installed successfully!")
        return True
    except subprocess.CalledProcessError as e:
        print(f"[Setup] Error installing dependencies: {e}")
        return False

def test_imports():
    print("[Setup] Testing imports...")
    try:
        import pandas
        print("  ✓ pandas")
        import numpy
        print("  ✓ numpy")
        import sklearn
        print("  ✓ scikit-learn")
        print("[Setup] Core imports OK")
        return True
    except ImportError as e:
        print(f"  ✗ {e}")
        return False

def test_agent():
    print("[Setup] Testing AI agent...")
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from ai_agent import analyze_token

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
        print(f"  ✓ Test result: APE={result['ape_probability']}, signal={result['signals']['signal']}")
        return True
    except Exception as e:
        print(f"  ✗ {e}")
        return False

if __name__ == "__main__":
    print("=" * 50)
    print("Meme Engine Python Setup")
    print("=" * 50)

    if not install_requirements():
        sys.exit(1)

    if not test_imports():
        print("[Setup] Warning: Some imports failed, but core should work")

    test_agent()

    print("\n[Setup] To start AI server:")
    print("  python ai_agent.py serve")
    print("\n[Setup] Or from Node.js it will auto-start")