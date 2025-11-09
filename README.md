# x402 Payment Edge Function for Supabase

A Supabase Edge Function implementation of the [x402 payment protocol](https://x402.org/) using Coinbase's x402 SDK. This function enables paywalled content access by requiring USDC payments on Base network before serving protected resources (like PDFs).

## Features

- ✅ x402-compliant payment verification and settlement
- ✅ Support for Base mainnet and Base Sepolia testnet
- ✅ USDC payment processing via Coinbase facilitator
- ✅ Protected resource delivery (PDFs from Supabase Storage)
- ✅ Signed URL generation for secure file access
- ✅ Comprehensive error handling and logging
- ✅ CORS support for web applications

## Prerequisites

- A Supabase project
- A Coinbase Developer Platform (CDP) API key
- A wallet address to receive payments
- Supabase CLI installed (`npm install -g supabase`)

## Setup

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd "Supabase Edge Func x402"
```

### 2. Link to Your Supabase Project

```bash
supabase link --project-ref your-project-ref
```

### 3. Set Required Secrets

Set the following secrets using Supabase CLI:

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

### 4. Optional Configuration

Set optional secrets to customize behavior:

```bash
# Optional: Custom PDF storage bucket (default: 'pdf')
supabase secrets set PDF_STORAGE_BUCKET=your-bucket-name

# Optional: Custom PDF file path (default: 'files/x402.pdf')
supabase secrets set PDF_FILE_NAME=path/to/your/file.pdf

# Optional: Custom resource URL
supabase secrets set RESOURCE_URL=https://your-domain.com/resource
```

### 5. Deploy

```bash
supabase functions deploy x402-payment
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `PAYMENT_DESTINATION_ADDRESS` | Ethereum wallet address to receive payments | `0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb` |
| `CDP_API_KEY_ID` | Coinbase API Key ID | (from Coinbase Developer Platform) |
| `CDP_API_KEY_SECRET` | Coinbase API Key Secret | (from Coinbase Developer Platform) |

**OR** (alternative)

| Variable | Description |
|----------|-------------|
| `CDP_API_KEY` | Single Coinbase API Key (if not using ID/Secret pair) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `PDF_STORAGE_BUCKET` | Supabase Storage bucket name containing PDF | `pdf` |
| `PDF_FILE_NAME` | Path to PDF file in storage bucket | `files/x402.pdf` |
| `RESOURCE_URL` | Resource URL for payment requirements | `https://x402.org/resource` |

### Automatically Available

These are automatically provided by Supabase Edge Functions:

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (for storage access)
- `SUPABASE_ANON_KEY` - Anonymous key (fallback)

## Usage

### Payment Flow

1. **Client requests resource** without payment header
   ```bash
   GET /functions/v1/x402-payment
   ```
   Returns: `402 Payment Required` with payment requirements

2. **Client generates payment authorization** using `@coinbase/x402` SDK

3. **Client requests resource** with payment header
   ```bash
   GET /functions/v1/x402-payment
   Headers:
     X-PAYMENT: <base64url-encoded-payment-authorization>
   ```
   Returns: `200 OK` with PDF URL (if payment verified)

### Response Format

**Success (200 OK):**
```json
{
  "pdfUrl": "https://your-project.supabase.co/storage/v1/object/sign/pdf/files/x402.pdf?token=...",
  "expiresIn": "1 hour",
  "message": "PDF URL expires in 1 hour"
}
```

**Payment Required (402):**
```json
{
  "x402Version": 1,
  "error": "Payment required to access this resource",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "10000",
    "resource": "https://your-project.supabase.co/functions/v1/x402-payment",
    "description": "Payment for resource access",
    "mimeType": "application/json",
    "payTo": "0xYourWalletAddress",
    "maxTimeoutSeconds": 60,
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "extra": {
      "name": "USD Coin",
      "version": "2"
    }
  }]
}
```

### Debug Endpoint

Test PDF URL generation without payment:

```bash
GET /functions/v1/x402-payment?debug=true
```

Returns:
```json
{
  "pdfUrl": "https://...",
  "bucket": "pdf",
  "fileName": "files/x402.pdf",
  "availableFiles": ["files/x402.pdf"]
}
```

## Payment Configuration

### Current Settings

- **Amount**: 0.01 USDC
- **Network**: Base (mainnet)
- **Currency**: USDC
- **Contract**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base mainnet)

### Testnet Support

The function automatically detects Base Sepolia testnet and uses:
- **Contract**: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **Name**: "USDC" (vs "USD Coin" on mainnet)

To use testnet, ensure your payment authorization uses `network: "base-sepolia"`.

## Storage Setup

1. **Create a storage bucket** in Supabase Dashboard:
   - Go to Storage → Create bucket
   - Name it `pdf` (or your custom name)
   - Set as private (recommended) or public

2. **Upload your PDF**:
   - Upload to `files/x402.pdf` (or your custom path)
   - Ensure the file is accessible

3. **Verify access**:
   - Use the debug endpoint: `/functions/v1/x402-payment?debug=true`

## Security Notes

- ✅ **No secrets in code** - All sensitive values use environment variables
- ✅ **Signed URLs** - PDFs are served via temporary signed URLs (1 hour expiry)
- ✅ **Payment verification** - All payments are verified via Coinbase facilitator
- ✅ **CORS enabled** - Configured for web application access

### Important Security Practices

1. **Never commit secrets** - Use Supabase secrets management
2. **Use service role key** - For storage access (automatically used)
3. **Private buckets** - Keep storage buckets private when possible
4. **Monitor logs** - Check Supabase Edge Function logs for suspicious activity

## Response Headers

- `X-PAYMENT-RESPONSE` - Base64URL-encoded settlement response (when payment succeeds)
- `X-Payment-Status` - Payment verification status (`verified`)
- `Access-Control-Allow-Origin` - CORS header (`*`)

## Error Handling

The function provides detailed error messages:

- `EMPTY_PAYLOAD` - Missing X-PAYMENT header
- `NOT_X402_PAYLOAD` - Invalid payment format
- `MISSING_API_CREDENTIALS` - Coinbase API keys not configured
- `AUTH_HEADER_CREATION_FAILED` - API authentication error
- `SETTLEMENT_ERROR` - Payment settlement failed
- `AUTHORIZATION_EXPIRED` - Payment authorization expired

## Troubleshooting

### "Object not found" Error

- Verify bucket name matches `PDF_STORAGE_BUCKET` (default: `pdf`)
- Verify file path matches `PDF_FILE_NAME` (default: `files/x402.pdf`)
- Check file exists in Supabase Storage
- Use debug endpoint to list available files

### Payment Verification Fails

- Ensure `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set correctly
- Verify payment authorization uses correct network (`base` or `base-sepolia`)
- Check payment amount matches (0.01 USDC = 10000 smallest units)
- Verify `PAYMENT_DESTINATION_ADDRESS` matches authorization `to` field

### Settlement Fails

- Check facilitator wallet has ETH for gas fees
- Verify authorization hasn't expired
- Check network/RPC connectivity
- Review Supabase Edge Function logs for detailed error messages

## Development

### Local Testing

```bash
# Start Supabase locally
supabase start

# Serve function locally
supabase functions serve x402-payment
```

### Project Structure

```
supabase/functions/x402-payment/
├── index.ts                 # Main Edge Function
├── deno.json               # Deno configuration
└── base64url/              # Buffer polyfill for base64url support
    ├── buffer-polyfill.ts
    └── mod.ts
```

## License

MIT License - feel free to use and modify as needed.

## Author

Created by [@davek_btc](https://x.com/davek_btc/)

## Resources

- [x402 Protocol Specification](https://x402.org/)
- [Coinbase x402 SDK](https://github.com/coinbase/x402)
- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Supabase Storage Docs](https://supabase.com/docs/guides/storage)

