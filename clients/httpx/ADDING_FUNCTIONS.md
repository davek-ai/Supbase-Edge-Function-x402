# Adding New Functions to the httpx Client

This guide explains how to add new x402-enabled Supabase Edge Functions to the test client.

## Quick Steps

1. **Edit `test_function.py`**
2. **Add your function to `FUNCTION_CONFIGS`**
3. **Test it!**

## Example: Adding a New Function

Let's say you have a new function called `my-new-function` that takes parameters `param1` and `param2`:

```python
FUNCTION_CONFIGS = {
    'toolzv4': {
        'description': 'IPv4 Network Connectivity Testing Tool',
        'default_params': {
            'target': '8.8.8.8',
            'count': '4',
            'timeout': '5000'
        }
    },
    'url-qr-code-generator': {
        'description': 'URL QR Code Generator',
        'default_params': {
            'url': 'https://example.com',
            'size': '200'
        }
    },
    # Add your new function here:
    'my-new-function': {
        'description': 'My New Function Description',
        'default_params': {
            'param1': 'default_value1',
            'param2': 'default_value2'
        }
    }
}
```

## Testing

After adding the function, test it:

```bash
# Use default parameters
uv run python test_function.py my-new-function

# Override parameters
uv run python test_function.py my-new-function param1=custom_value1 param2=custom_value2
```

## Current Functions

- **toolzv4**: IPv4 Network Connectivity Testing Tool
  - Parameters: `target`, `count`, `timeout`
  
- **url-qr-code-generator**: URL QR Code Generator
  - Parameters: `url`, `size`

## Notes

- All parameters are passed as query strings
- Default parameters are used if not specified
- The client automatically handles x402 payment flow
- Payment settlement is confirmed via `X-Payment-Response` header

