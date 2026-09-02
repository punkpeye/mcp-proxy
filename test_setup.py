#!/usr/bin/env python3
"""
Quick test to verify SOCKS5 proxy tool syntax and imports
"""

import sys
from pathlib import Path

def test_imports():
    """Test if all required modules can be imported"""
    print("Testing imports...")
    
    modules = [
        'requests',
        'bs4',
        'colorama',
        'socks',
        'threading',
        'json',
        'logging',
        'concurrent.futures',
        'dataclasses',
    ]
    
    missing = []
    for module in modules:
        try:
            __import__(module)
            print(f"  ✓ {module}")
        except ImportError as e:
            print(f"  ✗ {module}")
            missing.append(module)
    
    if missing:
        print(f"\n❌ Missing modules: {', '.join(missing)}")
        print(f"Install them with: pip install -r requirements.txt")
        return False
    
    print("\n✅ All imports successful!")
    return True

def test_syntax():
    """Test if the main script has valid Python syntax"""
    print("\nTesting syntax...")
    
    try:
        import py_compile
        py_compile.compile('socks5_proxy_tool.py', doraise=True)
        print("✅ Syntax check passed!")
        return True
    except py_compile.PyCompileError as e:
        print(f"❌ Syntax error: {e}")
        return False

if __name__ == "__main__":
    imports_ok = test_imports()
    syntax_ok = test_syntax()
    
    if imports_ok and syntax_ok:
        print("\n" + "="*50)
        print("🎉 All checks passed!")
        print("="*50)
        print("\nTo start the tool, run:")
        print("  python socks5_proxy_tool.py")
        print("\nFor help:")
        print("  python socks5_proxy_tool.py --help")
        sys.exit(0)
    else:
        print("\n❌ Some checks failed. Please fix the issues above.")
        sys.exit(1)
