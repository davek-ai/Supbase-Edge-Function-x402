# Supabase x402 Payment Edge Function

A production-ready Supabase Edge Function implementation of the [x402 payment protocol](https://x402.org/) that enables paywalled content access using USDC payments on the Base network.

## High-Level Overview

### What is x402?

x402 is an HTTP status code extension that enables paywalled content on the web. When a client requests a protected resource, the server responds with `402 Payment Required` and includes payment requirements in the response. The client then submits a payment authorization, and the server verifies and settles the payment before serving the resource.

### Architecture

This implementation consists of two main components:

1. **Supabase Edge Function** (`supabase/functions/x402-payment/`)
   - Implements the x402 payment protocol server-side
   - Verifies and settles USDC payments via Coinbase facilitator
   - Serves protected resources (PDFs) from Supabase Storage after payment verification
   - Supports both Base mainnet and Base Sepolia testnet

2. **Python Client Example** (`clients/httpx/`)
   - Demonstrates how to interact with x402-protected endpoints
   - Automatically handles payment flow using the `x402` Python package
   - Shows two integration approaches: simple and extensible

### How It Works

```
┌─────────┐                    ┌──────────────┐                    ┌─────────────┐
│ Client  │                    │ Supabase     │                    │ Coinbase    │
│         │                    │ Edge Func    │                    │ Facilitator │
└────┬────┘                    └──────┬───────┘                    └──────┬──────┘
     │                                 │                                  │
     │ 1. GET /x402-payment            │                                  │
     ├────────────────────────────────>│                                  │
     │                                 │                                  │
     │ 2. 402 Payment Required         │                                  │
     │    (with payment requirements)  │                                  │
     │<────────────────────────────────┤                                  │
     │                                 │                                  │
     │ 3. Create payment authorization │                                  │
     │    (signed with wallet)         │                                  │
     │                                 │                                  │
     │ 4. GET /x402-payment            │                                  │
     │    + X-Payment header           │                                  │
     ├────────────────────────────────>│                                  │
     │                                 │                                  │
     │                                 │ 5. Verify payment               │
     │                                 ├─────────────────────────────────>│
     │                                 │                                  │
     │                                 │ 6. Settlement result            │
     │                                 │<─────────────────────────────────┤
     │                                 │                                  │
     │ 7. 200 OK + Resource           │                                  │
     │    (PDF signed URL)            │                                  │
     │<────────────────────────────────┤                                  │
     │                                 │                                  │
```

### Key Features

- ✅ **x402-compliant**: Implements the full x402 payment protocol specification
- ✅ **USDC Payments**: Accepts USDC payments on Base mainnet and Base Sepolia testnet
- ✅ **Coinbase Integration**: Uses Coinbase Developer Platform (CDP) facilitator API
- ✅ **Protected Resources**: Serves PDFs from Supabase Storage after payment verification
- ✅ **Automatic Payment Handling**: Client library handles payment flow automatically
- ✅ **CORS Support**: Ready for web application integration
- ✅ **Error Handling**: Comprehensive error handling and logging

---

## Quick Start Guide

### Prerequisites

- A Supabase project ([create one here](https://supabase.com))
- A Coinbase Developer Platform API key ([get one here](https://portal.cdp.coinbase.com))
- A wallet address to receive payments
- Supabase CLI installed: `npm install -g supabase`
- Python 3.8+ and `uv` package manager (for client testing)

### Part 1: Deploy the Supabase Function

#### Step 1: Install Supabase CLI and Login

```bash
npm install -g supabase
supabase login
```

#### Step 2: Link Your Project

```bash
cd "Supabase Edge Func x402"
supabase link --project-ref your-project-ref
```

You can find your project ref in your Supabase dashboard URL: `https://supabase.com/dashboard/project/YOUR_PROJECT_REF`

#### Step 3: Set Required Secrets

Set your payment destination address and Coinbase API credentials:

```bash
# Required: Your wallet address to receive payments
supabase secrets set PAYMENT_DESTINATION_ADDRESS=0xYourWalletAddressHere

# Required: Coinbase API credentials (choose one method)
# Method 1: API Key ID and Secret (recommended)
supabase secrets set CDP_API_KEY_ID=your_api_key_id
supabase secrets set CDP_API_KEY_SECRET=your_api_key_secret

# Method 2: Single API Key (alternative)
supabase secrets set CDP_API_KEY=your_api_key
```

#### Step 4: Optional Configuration

Customize storage bucket and file paths (defaults are provided):

```bash
# Optional: Custom PDF storage bucket (default: 'pdf')
supabase secrets set PDF_STORAGE_BUCKET=your-bucket-name

# Optional: Custom PDF file path (default: 'files/x402.pdf')
supabase secrets set PDF_FILE_NAME=path/to/your/file.pdf

# Optional: Custom resource URL
supabase secrets set RESOURCE_URL=https://your-domain.com/resource
```

#### Step 5: Upload a PDF to Supabase Storage

1. Go to your Supabase dashboard → Storage
2. Create a bucket named `pdf` (or use your custom bucket name)
3. Upload a PDF file to `files/x402.pdf` (or your custom path)
4. Make sure the bucket is configured correctly (public or private with proper policies)

#### Step 6: Deploy the Function

```bash
supabase functions deploy x402-payment
```

#### Step 7: Verify Deployment

Test the function endpoint (should return 402 Payment Required):

```bash
curl https://YOUR_PROJECT_REF.supabase.co/functions/v1/x402-payment
```

You should see a JSON response with payment requirements.

---

### Part 2: Test with the Python Client

#### Step 1: Navigate to Client Directory

```bash
cd clients/httpx
```

#### Step 2: Set Up Environment Variables

Copy the example environment file and add your credentials:

```bash
cp .env-local .env
```

Edit `.env` and add your values:

```env
RESOURCE_SERVER_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/x402-payment
ENDPOINT_PATH=/x402-payment
PRIVATE_KEY=0xYourPrivateKeyHere
SUPABASE_ANON_KEY=your_supabase_anon_key
```

**Important Notes:**
- `PRIVATE_KEY`: Your wallet's private key (must have USDC on Base network for payments)
- `SUPABASE_ANON_KEY`: Found in your Supabase dashboard → Settings → API
- For testnet testing, ensure your wallet has Base Sepolia USDC

#### Step 3: Install Dependencies

```bash
uv sync
```

#### Step 4: Run the Client

```bash
uv run python main.py
```

The client will:
1. Make a request to the protected endpoint
2. Receive a 402 Payment Required response
3. Automatically create and sign a payment authorization
4. Submit the payment and verify settlement
5. Receive the protected resource (PDF signed URL)

#### Step 5: Verify Payment

Check the response output for:
- Payment transaction hash
- Resource URL (signed URL to the PDF)
- Success status

You can also verify the transaction on [BaseScan](https://basescan.org) (mainnet) or [Base Sepolia Explorer](https://sepolia.basescan.org) (testnet).

---

## Testing Tips

### Testnet vs Mainnet

The function defaults to Base mainnet. To test on Base Sepolia:

1. Modify `PAYMENT_REQUIREMENTS.network` in `index.ts` to `'base-sepolia'`
2. Redeploy: `supabase functions deploy x402-payment`
3. Ensure your test wallet has Base Sepolia USDC

### Debug Endpoint

Access the debug endpoint to check storage configuration:

```bash
curl "https://YOUR_PROJECT_REF.supabase.co/functions/v1/x402-payment?debug=true"
```

This returns:
- PDF signed URL
- Storage bucket configuration
- Available files in the bucket

### Common Issues

**Issue: "Payment payload is empty"**
- Ensure the client is sending the `X-Payment` header
- Check that the client library is properly configured

**Issue: "MISSING_API_CREDENTIALS"**
- Verify secrets are set: `supabase secrets list`
- Ensure CDP API keys are valid

**Issue: "Failed to create PDF URL"**
- Verify the storage bucket exists and is accessible
- Check the file path matches `PDF_FILE_NAME` secret
- Ensure proper storage policies are set

**Issue: Payment verification fails**
- Check that your wallet has sufficient USDC balance
- Verify network matches (mainnet vs testnet)
- Check Coinbase facilitator API status

---

## Project Structure

```
.
├── supabase/
│   ├── functions/
│   │   └── x402-payment/
│   │       ├── index.ts          # Main Edge Function implementation
│   │       ├── deno.json         # Deno configuration and imports
│   │       └── README.md         # Detailed function documentation
│   └── config.toml               # Supabase function configuration
├── clients/
│   └── httpx/
│       ├── main.py               # Simple client example
│       ├── extensible.py         # Extensible client example
│       ├── pyproject.toml        # Python dependencies
│       └── README.md             # Client documentation
└── README.md                     # This file
```

---

## Additional Resources

- [x402 Protocol Specification](https://x402.org/)
- [Coinbase x402 SDK Documentation](https://github.com/coinbase/x402)
- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Base Network Documentation](https://docs.base.org/)

---

Created by Davek https://x.com/davek_btc/ & Human https://x.com/human058382928

## License

This project is provided as-is for educational and demonstration purposes.

