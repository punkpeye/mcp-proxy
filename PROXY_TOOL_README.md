# Enhanced SOCKS5 Proxy Tool

A production-ready SOCKS5 proxy management tool with multithreading, robust error handling, and persistent storage.

## Features

### ✅ Core Functionality
- **Proper PySocks Integration**: Correct SOCKS5 proxy configuration using `socks.socksocket()`
- **Multithreaded Testing**: Parallel proxy validation using `ThreadPoolExecutor`
- **Retry Logic**: Automatic retry with exponential backoff on failures
- **Persistent Storage**: Automatically saves working proxies to `working_proxies.json`
- **Speed Measurement**: Response time tracking in milliseconds
- **Comprehensive Logging**: File and console logging to `proxy_tool.log`

### 🎯 Bug Fixes from Original
| Issue | Fix |
|-------|-----|
| ❌ `socks.socks5 = proxy` invalid | ✅ Use `sock.set_proxy(socks.SOCKS5, ip, port)` |
| ❌ Blocking I/O | ✅ ThreadPoolExecutor with configurable workers |
| ❌ No error recovery | ✅ Retry logic with timeout handling |
| ❌ Fragile HTML parsing | ✅ Multiple proxy sources + error handling |
| ❌ No persistence | ✅ JSON-based proxy cache |

### 🚀 Additional Features
- **Proxy Metadata**: Track IP, port, protocol, country, anonymity level
- **Dataclass Model**: Type-safe proxy representation
- **Best Proxy Selection**: Auto-select fastest working proxy
- **Detailed CLI**: 8-menu interactive interface with settings
- **Single Proxy Testing**: Test individual proxy manually
- **Configurable Timeouts**: Set connection timeout and worker count
- **Color-Coded Output**: Easy-to-read status indicators
- **Progress Tracking**: Real-time testing progress

## Installation

```bash
pip install -r requirements.txt
```

## Usage

### Interactive Mode (Recommended)
```bash
python socks5_proxy_tool.py
```

### Command Line Options
```bash
# Custom timeout (10 seconds)
python socks5_proxy_tool.py --timeout 10

# Custom worker threads (20 parallel tests)
python socks5_proxy_tool.py --workers 20

# Both
python socks5_proxy_tool.py --timeout 8 --workers 15
```

## Menu Options

1. **Fetch Proxies**: Scrape from multiple sources with retry logic
2. **Test All Proxies**: Validate all loaded proxies in parallel
3. **List Proxies**: Show all proxies organized by status
4. **Auto-Select Best**: Find the fastest working proxy
5. **Test Single Proxy**: Validate a specific IP:port
6. **Settings**: Configure timeout and worker threads
7. **Help**: Show detailed help menu
8. **Exit**: Close the program

## Output Files

- **working_proxies.json**: Cached working proxies with metadata (auto-updated after testing)
- **proxy_tool.log**: Detailed execution logs

## Architecture

### ProxyManager Class
- **Thread-safe**: Uses locks for concurrent access
- **Lazy loading**: Loads cached proxies on startup
- **Modular design**: Separate methods for fetch/test/validate/persist

### Key Methods

```python
# Fetch from multiple sources with retry
fetch_proxies()

# Test in parallel
test_proxies_parallel(proxies=None)

# Test single proxy
test_proxy(proxy: Proxy) -> bool

# Get all valid proxies sorted by speed
get_working_proxies() -> List[Proxy]

# Save to persistent storage
save_proxies_to_file()

# Load from persistent storage
load_proxies_from_file()
```

## Performance

- **10 proxies**: ~5-10 seconds (parallel testing with 10 workers)
- **100 proxies**: ~30-60 seconds
- **Speed variance**: Depends on proxy quality and timeout setting

**Tip**: Use `--workers 20` for faster testing on large proxy lists, or `--workers 5` for lighter resource usage.

## Error Handling

- **Network timeouts**: Graceful timeout with retry
- **Malformed HTML**: Fallback to next proxy source
- **Invalid IPs**: Validation via `socket.inet_aton()`
- **Concurrent access**: Thread-safe lock protection
- **Missing files**: Graceful handling of cache misses

## Example Workflow

```bash
# 1. Start the tool
python socks5_proxy_tool.py --timeout 5 --workers 10

# 2. Fetch proxies
# Menu → 1

# 3. Test all proxies
# Menu → 2

# 4. View results
# Menu → 3

# 5. Auto-select best
# Menu → 4

# 6. Use the proxy in your application
# Read from working_proxies.json or use displayed IP:port
```

## Configuration

Edit the `ProxyManager` class constants:

```python
PROXY_SITES = [
    'https://www.sslproxies.org/',
    'https://www.socksproxylist.net/',
    # Add more sources here
]

TEST_URLS = [
    'http://httpbin.org/ip',
    'http://api.ipify.org?format=json',
    # Add more test URLs here
]
```

## Troubleshooting

### "No proxies fetched"
- Check internet connection
- Verify proxy sites are still online
- Try increasing timeout: `--timeout 10`

### "All proxies failed"
- Proxies may be dead/rate-limited
- Try fetching fresh proxies (menu option 1)
- Check `proxy_tool.log` for detailed errors

### "Slow testing"
- Increase `--workers` (10 is default, try 20)
- Decrease `--timeout` (risky, may skip valid proxies)

## Notes

- SOCKS5 proxies only (not SOCKS4 or HTTP proxies)
- Requires internet connection for testing
- Proxy quality depends on source
- Testing respects timeouts to avoid hanging

## License

MIT
