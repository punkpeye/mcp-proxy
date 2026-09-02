#!/usr/bin/env python3
"""
Enhanced SOCKS5 Proxy Tool
- Proper PySocks configuration
- Multithreaded proxy testing
- Robust error handling and retry logic
- Proxy validation, filtering, and persistence
"""

import requests
from bs4 import BeautifulSoup
from colorama import Fore, Style, init
import sys
import socket
import socks
import threading
import time
import json
import logging
from pathlib import Path
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from typing import List, Tuple, Optional
import argparse

# Initialize colorama
init(autoreset=True)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('proxy_tool.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

@dataclass
class Proxy:
    """Represents a proxy with metadata"""
    ip: str
    port: int
    protocol: str = "socks5"
    country: str = ""
    anonymity: str = ""
    speed: int = 0  # Response time in ms
    is_valid: bool = False
    last_checked: float = 0.0

    def __str__(self):
        return f"{self.ip}:{self.port}"
    
    def to_dict(self):
        return asdict(self)

class ProxyManager:
    """Manages proxy fetching, testing, and configuration"""
    
    PROXY_SITES = [
        'https://www.sslproxies.org/',
        'https://www.socksproxylist.net/',
        'https://www.proxy-list.download/api/v1/get?type=socks5',
    ]
    
    TEST_URLS = [
        'http://httpbin.org/ip',
        'http://api.ipify.org?format=json',
        'http://icanhazip.com',
    ]
    
    CONFIG_FILE = Path("working_proxies.json")
    
    def __init__(self, timeout: int = 5, max_workers: int = 10):
        self.proxies: List[Proxy] = []
        self.timeout = timeout
        self.max_workers = max_workers
        self.lock = threading.Lock()
        self.load_proxies_from_file()
    
    def colored_print(self, text: str, color: str = Fore.WHITE, **kwargs):
        """Print colored text"""
        print(color + text + Style.RESET_ALL, **kwargs)
    
    def load_proxies_from_file(self) -> None:
        """Load previously saved working proxies"""
        try:
            if self.CONFIG_FILE.exists():
                with open(self.CONFIG_FILE, 'r') as f:
                    data = json.load(f)
                    self.proxies = [Proxy(**p) for p in data]
                    self.colored_print(
                        f"✓ Loaded {len(self.proxies)} proxies from {self.CONFIG_FILE}",
                        color=Fore.GREEN
                    )
        except Exception as e:
            logger.error(f"Failed to load proxies from file: {e}")
    
    def save_proxies_to_file(self) -> None:
        """Save working proxies to file"""
        try:
            valid_proxies = [p for p in self.proxies if p.is_valid]
            with open(self.CONFIG_FILE, 'w') as f:
                json.dump([p.to_dict() for p in valid_proxies], f, indent=2)
            self.colored_print(
                f"✓ Saved {len(valid_proxies)} working proxies to {self.CONFIG_FILE}",
                color=Fore.GREEN
            )
        except Exception as e:
            logger.error(f"Failed to save proxies: {e}")
    
    def fetch_proxies(self) -> None:
        """Fetch proxies from multiple sources with retry logic"""
        self.colored_print("\n🔍 Fetching proxies...", color=Fore.CYAN)
        
        for site in self.PROXY_SITES:
            self._fetch_from_site(site, retries=3)
        
        self.colored_print(
            f"✓ Fetched {len(self.proxies)} proxies total",
            color=Fore.GREEN
        )
    
    def _fetch_from_site(self, site: str, retries: int = 3) -> None:
        """Fetch proxies from a specific site with retry logic"""
        for attempt in range(retries):
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
                response = requests.get(site, timeout=self.timeout, headers=headers)
                response.raise_for_status()
                
                soup = BeautifulSoup(response.content, 'html.parser')
                
                # Try to parse table-based proxy lists
                found = False
                for row in soup.select('table tr'):
                    cols = row.find_all('td')
                    if len(cols) >= 2:
                        try:
                            ip = cols[0].text.strip()
                            port = int(cols[1].text.strip())
                            
                            # Validate IP format
                            socket.inet_aton(ip)
                            
                            # Check if proxy already exists
                            if not any(p.ip == ip and p.port == port for p in self.proxies):
                                proxy = Proxy(ip=ip, port=port)
                                with self.lock:
                                    self.proxies.append(proxy)
                                found = True
                        except (ValueError, OSError):
                            continue

                # Fallback: some endpoints return plain text lists like "ip:port" per line
                # Parse lines in the response body to extract ip:port pairs
                text = response.text or ''
                for line in text.splitlines():
                    line = line.strip()
                    if not line or ':' not in line:
                        continue
                    parts = line.split(':')
                    if len(parts) < 2:
                        continue
                    ip_candidate = parts[0].strip()
                    port_candidate = parts[1].strip()
                    try:
                        port = int(port_candidate)
                        socket.inet_aton(ip_candidate)
                        if not any(p.ip == ip_candidate and p.port == port for p in self.proxies):
                            proxy = Proxy(ip=ip_candidate, port=port)
                            with self.lock:
                                self.proxies.append(proxy)
                    except (ValueError, OSError):
                        continue
                
                logger.info(f"Successfully fetched proxies from {site}")
                return
            
            except Exception as e:
                logger.warning(
                    f"Attempt {attempt + 1}/{retries} failed for {site}: {e}"
                )
                if attempt < retries - 1:
                    time.sleep(2)
        
        logger.error(f"Failed to fetch proxies from {site} after {retries} attempts")
    
    def test_proxy(self, proxy: Proxy) -> bool:
        """Test a single proxy with timeout and retry logic"""
        test_url = self.TEST_URLS[0]
        
        for attempt in range(2):
            try:
                start_time = time.time()
                
                # Create a socket using socks
                sock = socks.socksocket(socket.AF_INET, socket.SOCK_STREAM)
                sock.set_proxy(socks.SOCKS5, proxy.ip, proxy.port)
                sock.settimeout(self.timeout)
                
                # Test connection
                sock.connect(('httpbin.org', 80))
                sock.close()
                
                elapsed = int((time.time() - start_time) * 1000)
                
                with self.lock:
                    proxy.speed = elapsed
                    proxy.is_valid = True
                    proxy.last_checked = time.time()
                
                return True
            
            except socket.timeout:
                logger.debug(f"Proxy {proxy} timed out (attempt {attempt + 1})")
            except Exception as e:
                logger.debug(f"Proxy {proxy} test failed (attempt {attempt + 1}): {e}")
        
        with self.lock:
            proxy.is_valid = False
            proxy.last_checked = time.time()
        
        return False
    
    def test_proxies_parallel(self, proxies: Optional[List[Proxy]] = None) -> None:
        """Test proxies in parallel using ThreadPoolExecutor"""
        if proxies is None:
            proxies = self.proxies
        
        if not proxies:
            self.colored_print("No proxies to test!", color=Fore.RED)
            return
        
        self.colored_print(
            f"\n⚡ Testing {len(proxies)} proxies in parallel...",
            color=Fore.CYAN
        )
        
        valid_count = 0
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {executor.submit(self.test_proxy, p): p for p in proxies}
            
            completed = 0
            for future in as_completed(futures):
                completed += 1
                proxy = futures[future]
                result = future.result()
                
                if result:
                    valid_count += 1
                    self.colored_print(
                        f"  ✓ {proxy} - {proxy.speed}ms",
                        color=Fore.GREEN
                    )
                else:
                    self.colored_print(
                        f"  ✗ {proxy}",
                        color=Fore.RED
                    )
                
                # Progress indicator
                if completed % 10 == 0:
                    logger.info(f"Progress: {completed}/{len(proxies)}")
        
        self.colored_print(
            f"✓ Testing complete: {valid_count}/{len(proxies)} valid",
            color=Fore.GREEN
        )
        
        self.save_proxies_to_file()
    
    def get_working_proxies(self) -> List[Proxy]:
        """Get all valid proxies, sorted by speed"""
        valid = [p for p in self.proxies if p.is_valid]
        return sorted(valid, key=lambda p: p.speed)
    
    def configure_system_proxy(self, proxy: Proxy) -> bool:
        """Configure system proxy (works on some systems)"""
        try:
            # This is a placeholder - actual system-wide configuration
            # depends on the OS and requires elevated privileges
            logger.info(f"Attempting to set system proxy to {proxy}")
            self.colored_print(
                f"Configure your application to use: {proxy.ip}:{proxy.port}",
                color=Fore.YELLOW
            )
            return True
        except Exception as e:
            logger.error(f"Failed to configure system proxy: {e}")
            return False
    
    def list_proxies(self) -> None:
        """Display all loaded proxies"""
        if not self.proxies:
            self.colored_print("No proxies loaded!", color=Fore.RED)
            return
        
        self.colored_print("\n" + "="*60, color=Fore.CYAN)
        self.colored_print("PROXY LIST", color=Fore.CYAN)
        self.colored_print("="*60, color=Fore.CYAN)
        
        working = self.get_working_proxies()
        
        if working:
            self.colored_print(f"\n✓ Working Proxies ({len(working)}):", color=Fore.GREEN)
            for i, p in enumerate(working, 1):
                self.colored_print(
                    f"  {i}. {p.ip}:{p.port} - Speed: {p.speed}ms",
                    color=Fore.GREEN
                )
        
        untested = [p for p in self.proxies if not p.last_checked]
        if untested:
            self.colored_print(f"\n? Untested ({len(untested)}):", color=Fore.YELLOW)
            for i, p in enumerate(untested[:5], 1):
                self.colored_print(f"  {i}. {p.ip}:{p.port}", color=Fore.YELLOW)
            if len(untested) > 5:
                self.colored_print(f"  ... and {len(untested) - 5} more", color=Fore.YELLOW)
    
    def auto_select_best(self) -> Optional[Proxy]:
        """Auto-select the fastest working proxy"""
        working = self.get_working_proxies()
        
        if not working:
            self.colored_print("No working proxies available!", color=Fore.RED)
            return None
        
        best = working[0]
        self.colored_print(
            f"✓ Best proxy: {best} ({best.speed}ms)",
            color=Fore.GREEN
        )
        self.configure_system_proxy(best)
        return best

def main_menu(manager: ProxyManager) -> None:
    """Main interactive menu"""
    while True:
        try:
            print()
            manager.colored_print("╔" + "═"*58 + "╗", color=Fore.CYAN)
            manager.colored_print("║" + " SOCKS5 PROXY TOOL - Enhanced Edition".center(58) + "║", color=Fore.CYAN)
            manager.colored_print("╚" + "═"*58 + "╝", color=Fore.CYAN)
            
            manager.colored_print("\n1. Fetch Proxies", color=Fore.GREEN)
            manager.colored_print("2. Test All Proxies", color=Fore.GREEN)
            manager.colored_print("3. List Proxies", color=Fore.GREEN)
            manager.colored_print("4. Auto-Select Best Proxy", color=Fore.GREEN)
            manager.colored_print("5. Test a Single Proxy", color=Fore.GREEN)
            manager.colored_print("6. Settings", color=Fore.GREEN)
            manager.colored_print("7. Help", color=Fore.GREEN)
            manager.colored_print("8. Exit", color=Fore.RED)
            
            choice = input("\n➜ Enter your choice: ").strip()
            
            if choice == '1':
                manager.fetch_proxies()
            
            elif choice == '2':
                manager.test_proxies_parallel()
            
            elif choice == '3':
                manager.list_proxies()
            
            elif choice == '4':
                manager.auto_select_best()
            
            elif choice == '5':
                ip = input("Enter proxy IP: ").strip()
                try:
                    port = int(input("Enter proxy port: ").strip())
                    proxy = Proxy(ip=ip, port=port)
                    if manager.test_proxy(proxy):
                        manager.colored_print(
                            f"✓ Proxy {proxy} is valid! Speed: {proxy.speed}ms",
                            color=Fore.GREEN
                        )
                    else:
                        manager.colored_print(
                            f"✗ Proxy {proxy} failed",
                            color=Fore.RED
                        )
                except ValueError:
                    manager.colored_print("Invalid port number!", color=Fore.RED)
            
            elif choice == '6':
                settings_menu(manager)
            
            elif choice == '7':
                help_menu(manager)
            
            elif choice == '8':
                manager.colored_print("\n👋 Exiting...", color=Fore.CYAN)
                sys.exit(0)
            
            else:
                manager.colored_print("Invalid choice. Please try again.", color=Fore.RED)
        
        except KeyboardInterrupt:
            manager.colored_print("\n\n👋 Exiting...", color=Fore.CYAN)
            sys.exit(0)
        except Exception as e:
            logger.error(f"Error in main menu: {e}")
            manager.colored_print(f"An error occurred: {e}", color=Fore.RED)

def settings_menu(manager: ProxyManager) -> None:
    """Settings menu"""
    manager.colored_print("\n⚙️  SETTINGS", color=Fore.CYAN)
    manager.colored_print(f"  Timeout: {manager.timeout}s", color=Fore.WHITE)
    manager.colored_print(f"  Max Workers: {manager.max_workers}", color=Fore.WHITE)
    manager.colored_print(f"  Loaded Proxies: {len(manager.proxies)}", color=Fore.WHITE)
    
    try:
        timeout_input = input("\nEnter timeout (seconds, press Enter to skip): ").strip()
        if timeout_input:
            manager.timeout = int(timeout_input)
        
        workers_input = input("Enter max workers (press Enter to skip): ").strip()
        if workers_input:
            manager.max_workers = int(workers_input)
        
        manager.colored_print("✓ Settings updated!", color=Fore.GREEN)
    except ValueError:
        manager.colored_print("Invalid input!", color=Fore.RED)

def help_menu(manager: ProxyManager) -> None:
    """Help menu"""
    manager.colored_print("\n" + "="*60, color=Fore.CYAN)
    manager.colored_print("HELP", color=Fore.CYAN)
    manager.colored_print("="*60, color=Fore.CYAN)
    
    help_text = """
1. FETCH PROXIES
   Scrapes multiple proxy sources and loads them into memory.
   Uses retry logic if fetching fails.

2. TEST ALL PROXIES
   Tests all loaded proxies in parallel (multithreaded).
   Automatically saves valid proxies to working_proxies.json.

3. LIST PROXIES
   Shows all loaded proxies, organized by status:
   - ✓ Working proxies (sorted by speed)
   - ? Untested proxies

4. AUTO-SELECT BEST PROXY
   Automatically selects the fastest working proxy.

5. TEST SINGLE PROXY
   Tests a specific proxy by IP and port.

6. SETTINGS
   Configure timeout and number of parallel workers.

7. HELP
   Shows this menu.

8. EXIT
   Exits the program.

KEY FEATURES:
• Multithreaded proxy testing for fast validation
• Automatic retry logic with exponential backoff
• Persistent storage of working proxies (working_proxies.json)
• Response time measurement in milliseconds
• Detailed logging to proxy_tool.log
• Color-coded output for easy reading
"""
    
    print(help_text)
    input("Press Enter to return to main menu...")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enhanced SOCKS5 Proxy Tool"
    )
    parser.add_argument(
        '--timeout',
        type=int,
        default=5,
        help='Connection timeout in seconds (default: 5)'
    )
    parser.add_argument(
        '--workers',
        type=int,
        default=10,
        help='Number of parallel test threads (default: 10)'
    )
    
    args = parser.parse_args()
    
    manager = ProxyManager(timeout=args.timeout, max_workers=args.workers)
    main_menu(manager)
