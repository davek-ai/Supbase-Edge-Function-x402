#!/usr/bin/env python3
"""
Test any x402-enabled Supabase Edge Function with payment handling.

Usage:
    # Test toolzv4
    python test_function.py toolzv4 target=8.8.8.8 count=4 timeout=5000
    
    # Test url-qr-code-generator
    python test_function.py url-qr-code-generator url=https://example.com size=300
    
    # Or use environment variables
    FUNCTION_NAME=toolzv4 python test_function.py target=8.8.8.8 count=4
"""

import os
import sys
import asyncio
from dotenv import load_dotenv
from eth_account import Account
from x402.clients.httpx import x402HttpxClient
from x402.clients.base import decode_x_payment_response, x402Client
from urllib.parse import urlencode

# Load environment variables
load_dotenv()

# Function configurations - add new functions here
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
    'email-validator': {
        'description': 'Email Validator - Validates email address format using RFC-style patterns',
        'default_params': {
            'email': 'user@example.com'
        }
    }
}


def custom_payment_selector(
    accepts, network_filter=None, scheme_filter=None, max_value=None
):
    """Custom payment selector that filters by network."""
    return x402Client.default_payment_requirements_selector(
        accepts,
        network_filter="base",
        scheme_filter=scheme_filter,
        max_value=max_value,
    )


def parse_args():
    """Parse command line arguments."""
    args = sys.argv[1:]
    
    if not args:
        print("Usage: python test_function.py <function_name> [param=value ...]")
        print("\nAvailable functions:")
        for func_name, config in FUNCTION_CONFIGS.items():
            print(f"  {func_name}: {config['description']}")
            print(f"    Default params: {config['default_params']}")
        sys.exit(1)
    
    # First arg is function name (or get from env)
    function_name = os.getenv('FUNCTION_NAME') or args[0]
    
    # If first arg is not a function name, use it as a param
    if function_name in FUNCTION_CONFIGS:
        params = {}
        # Parse remaining args as key=value pairs
        for arg in args[1:] if not os.getenv('FUNCTION_NAME') else args:
            if '=' in arg:
                key, value = arg.split('=', 1)
                params[key] = value
    else:
        # First arg is a param, use default function or require FUNCTION_NAME
        if not os.getenv('FUNCTION_NAME'):
            print(f"Error: '{function_name}' is not a known function.")
            print("Available functions:", list(FUNCTION_CONFIGS.keys()))
            sys.exit(1)
        function_name = os.getenv('FUNCTION_NAME')
        params = {}
        for arg in args:
            if '=' in arg:
                key, value = arg.split('=', 1)
                params[key] = value
    
    return function_name, params


async def test_function(function_name: str, params: dict):
    """Test a function with x402 payment."""
    # Get function config
    if function_name not in FUNCTION_CONFIGS:
        print(f"❌ Unknown function: {function_name}")
        print(f"Available functions: {list(FUNCTION_CONFIGS.keys())}")
        return
    
    config = FUNCTION_CONFIGS[function_name]
    
    # Merge default params with provided params
    final_params = {**config['default_params'], **params}
    
    # Build endpoint path
    query_string = urlencode(final_params)
    endpoint_path = f"/functions/v1/{function_name}?{query_string}"
    
    # Get environment variables
    private_key = os.getenv("PRIVATE_KEY")
    base_url = os.getenv("RESOURCE_SERVER_URL") or "https://xluihnzwcmxybtygewvy.supabase.co"
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")
    
    if not private_key:
        print("❌ Error: PRIVATE_KEY environment variable is required")
        print("Set it in .env file or environment")
        return
    
    # Build headers
    headers = {}
    if supabase_anon_key:
        headers["Authorization"] = f"Bearer {supabase_anon_key}"
        headers["Content-Type"] = "application/json"
    
    # Create account
    account = Account.from_key(private_key)
    
    print(f"🧪 Testing Function: {function_name}")
    print(f"📝 Description: {config['description']}")
    print(f"🌐 Endpoint: {endpoint_path}")
    print(f"📡 Base URL: {base_url}")
    print(f"🔐 Account: {account.address}")
    print(f"📋 Parameters: {final_params}")
    print()
    print("=" * 60)
    print("x402 Payment Flow:")
    print("=" * 60)
    print("1. Initial request (expecting 402 Payment Required)...")
    
    # Create client and make request
    async with x402HttpxClient(
        account=account,
        base_url=base_url,
        payment_requirements_selector=custom_payment_selector,
        headers=headers,
    ) as client:
        try:
            response = await client.get(endpoint_path)
            
            print(f"2. Response Status: {response.status_code}")
            
            # Read response
            content = await response.aread()
            content_str = content.decode()
            
            # Show response headers
            print(f"\n📋 Response Headers:")
            for key, value in response.headers.items():
                if 'payment' in key.lower() or 'x-' in key.lower():
                    print(f"   {key}: {value[:100]}..." if len(str(value)) > 100 else f"   {key}: {value}")
            
            # Show response body
            print(f"\n📦 Response Body:")
            try:
                import json
                data = json.loads(content_str)
                print(json.dumps(data, indent=2))
            except:
                print(content_str[:500])
            
            # Verify payment
            print(f"\n{'=' * 60}")
            print("X-PAYMENT Header Verification:")
            print(f"{'=' * 60}")
            if response.status_code == 200:
                print("✅ Payment verified successfully!")
                print("   (x402HttpxClient automatically handled the payment flow)")
            elif response.status_code == 402:
                print("⚠️  Received 402 Payment Required")
                print("   Payment was not processed correctly")
            else:
                print(f"⚠️  Unexpected status code: {response.status_code}")
            
            # Check payment response header
            if "X-Payment-Response" in response.headers:
                payment_response = decode_x_payment_response(
                    response.headers["X-Payment-Response"]
                )
                print(f"\n✅ Payment Settlement Confirmed:")
                print(f"   Transaction: {payment_response.get('transaction', 'N/A')}")
                print(f"   Network: {payment_response.get('network', 'N/A')}")
                print(f"   Payer: {payment_response.get('payer', 'N/A')}")
            else:
                print(f"\n⚠️  No X-Payment-Response header")
                print(f"   (Payment verified but settlement header not present)")
        
        except Exception as e:
            print(f"\n❌ Error occurred: {str(e)}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    function_name, params = parse_args()
    asyncio.run(test_function(function_name, params))

