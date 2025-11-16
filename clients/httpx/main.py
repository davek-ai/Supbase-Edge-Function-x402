import os
import asyncio
from dotenv import load_dotenv
from eth_account import Account
from x402.clients.httpx import x402HttpxClient
from x402.clients.base import decode_x_payment_response, x402Client

# Load environment variables
load_dotenv()

# Get environment variables
private_key = os.getenv("PRIVATE_KEY")
base_url = os.getenv("RESOURCE_SERVER_URL")
endpoint_path = os.getenv("ENDPOINT_PATH")
supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")

if not all([private_key, base_url, endpoint_path]):
    print("Error: Missing required environment variables")
    exit(1)

# Build headers with Supabase authentication if available
headers = {}
if supabase_anon_key:
    headers["Authorization"] = f"Bearer {supabase_anon_key}"
    headers["Content-Type"] = "application/json"
    print("Using Authorization header with Supabase anon key")

# Create eth_account from private key
account = Account.from_key(private_key)
print(f"Initialized account: {account.address}")


def custom_payment_selector(
    accepts, network_filter=None, scheme_filter=None, max_value=None
):
    """Custom payment selector that filters by network."""
    # Ignore the network_filter parameter for this example - we hardcode base-sepolia
    _ = network_filter

    # NOTE: In a real application, you'd want to dynamically choose the most
    # appropriate payment requirement based on user preferences, available funds,
    # network conditions, or other business logic rather than hardcoding a network.

    # Filter by base-sepolia network (testnet)
    return x402Client.default_payment_requirements_selector(
        accepts,
        network_filter="base",
        scheme_filter=scheme_filter,
        max_value=max_value,
    )


async def main():
    # Create x402HttpxClient with built-in payment handling and network filtering
    async with x402HttpxClient(
        account=account,
        base_url=base_url,
        payment_requirements_selector=custom_payment_selector,
        headers=headers,
    ) as client:
        # Make request - payment handling is automatic
        try:
            assert endpoint_path is not None  # we already guard against None above
            print(f"🌐 Making request to: {endpoint_path}")
            print(f"📡 Base URL: {base_url}")
            print(f"🔐 Account: {account.address}")
            print()
            print("=" * 60)
            print("x402 Payment Flow:")
            print("=" * 60)
            print("1. Initial request (expecting 402 Payment Required)...")
            
            response = await client.get(endpoint_path)
            
            print(f"2. Response Status: {response.status_code}")
            
            # Read the response content
            content = await response.aread()
            content_str = content.decode()
            
            # Show response details
            print(f"\n📋 Response Headers:")
            x_payment_sent = False
            for key, value in response.headers.items():
                if 'payment' in key.lower() or 'x-' in key.lower():
                    print(f"   {key}: {value[:100]}..." if len(str(value)) > 100 else f"   {key}: {value}")
                    if 'x-payment' in key.lower():
                        x_payment_sent = True
            
            print(f"\n📦 Response Body:")
            try:
                import json
                data = json.loads(content_str)
                print(json.dumps(data, indent=2))
            except:
                print(content_str[:500])
            
            # Verify X-PAYMENT header was sent
            print(f"\n{'=' * 60}")
            print("X-PAYMENT Header Verification:")
            print(f"{'=' * 60}")
            if response.status_code == 200:
                print("✅ Payment verified successfully!")
                print("   (x402HttpxClient automatically handled the payment flow)")
                print("   - Received 402 Payment Required")
                print("   - Generated payment authorization")
                print("   - Sent request with X-PAYMENT header")
                print("   - Received 200 OK with function result")
            elif response.status_code == 402:
                print("⚠️  Received 402 Payment Required")
                print("   This means payment was not processed correctly")
                print("   Check payment requirements and wallet balance")
            else:
                print(f"⚠️  Unexpected status code: {response.status_code}")

            # Check for payment response header
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
                print(f"   Payment was verified but settlement header not present")
                print(f"   (This is normal if settlement failed but verification passed)")

        except Exception as e:
            print(f"\n❌ Error occurred: {str(e)}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
