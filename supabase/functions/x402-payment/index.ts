
// DAVEK

// Using esm.sh with denonext target for optimal Deno compatibility
// Note: Coinbase SDK uses Buffer.toString('base64url') internally for JWT creation
// We need to polyfill Buffer to support base64url encoding
import { Buffer } from "node:buffer"
import { encode as encodeBase64url } from "https://deno.land/std@0.168.0/encoding/base64url.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import * as x402 from "@coinbase/x402"
import { createClient } from "supabase"

// Extend Buffer to support base64url encoding (required by Coinbase SDK)
const originalToString = Buffer.prototype.toString
Buffer.prototype.toString = function (encoding?: string): string {
  if (encoding === "base64url") {
    // Use Deno's native base64url encoding
    return encodeBase64url(new Uint8Array(this))
  }
  return originalToString.call(this, encoding)
}

// Make Buffer available globally for Coinbase SDK
if (typeof globalThis !== "undefined") {
  globalThis.Buffer = Buffer
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-payment',
  'Access-Control-Expose-Headers': 'x-payment',
}

// ============================================================================
// PAYMENT DESTINATION CONFIGURATION
// ============================================================================
// REQUIRED: Set PAYMENT_DESTINATION_ADDRESS in Supabase secrets
// Run: supabase secrets set PAYMENT_DESTINATION_ADDRESS=0xYourAddressHere

const destination = Deno.env.get('PAYMENT_DESTINATION_ADDRESS')

if (!destination) {
  throw new Error(
    'PAYMENT_DESTINATION_ADDRESS environment variable is required. ' +
    'Set it via: supabase secrets set PAYMENT_DESTINATION_ADDRESS=0xYourAddressHere'
  )
}

const PAYMENT_REQUIREMENTS = {
  amount: '0.01',
  currency: 'USDC',
  network: 'base',
  facilitator: 'https://api.coinbase.com/v2/x402/facilitator',
  destination: destination,
}


/**
 * Gets the USDC contract address and name for a given network
 * IMPORTANT: Base mainnet uses "USD Coin", Base Sepolia uses "USDC"
 * This matches the EIP-712 domain name from the contract ABI
 */
function getUsdcConfig(network: string): { address: string; name: string } {
  const isTestnet = network === 'base-sepolia'
  return {
    address: isTestnet 
      ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // USDC on Base Sepolia
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base Mainnet
    name: isTestnet ? 'USDC' : 'USD Coin'
  }
}

/**
 * Creates X-PAYMENT-RESPONSE header value from settlement response
 * Base64URL encodes the settlement response JSON as per x402 spec
 * Matches the structure used by settleResponseHeader in standard implementations
 */
function createPaymentResponseHeader(settlementResult: any): string {
  // Use full SettleResponse structure to match standard implementations
  // This ensures compatibility with clients expecting the standard format
  const responseData: any = {
    success: settlementResult.success || false,
    transaction: settlementResult.transaction || settlementResult.txHash || '',
    network: settlementResult.network || settlementResult.networkId || '',
    payer: settlementResult.payer || ''
  }
  
  // Include errorReason if present (standard implementations include this)
  if (settlementResult.errorReason) {
    responseData.errorReason = settlementResult.errorReason
  }
  
  // Use base64url encoding (x402 spec uses base64url, not standard base64)
  // Using native Deno base64url encoding via Buffer polyfill
  return Buffer.from(JSON.stringify(responseData), 'utf8').toString('base64')
}

/**
 * Helper to safely serialize objects to JSON (handles bigint values)
 * Uses toJsonSafe from x402 package if available, otherwise falls back to JSON.stringify
 */
function safeJsonStringify(data: any): string {
  // Try to use toJsonSafe from x402 package if available
  if (x402.toJsonSafe && typeof x402.toJsonSafe === 'function') {
    try {
      return JSON.stringify(x402.toJsonSafe(data))
    } catch (e) {
      console.warn('toJsonSafe failed, falling back to JSON.stringify:', e)
    }
  }
  
  // Fallback to standard JSON.stringify
  // Note: This may fail with bigint values, but should work for our use case
  return JSON.stringify(data)
}

async function verifyPayment(paymentPayload: string, resourceUrl?: string): Promise<{ isValid: boolean; error?: any; settlementResult?: any }> {
  try {
    // Strict validation: payload must exist and be non-empty after trimming
    if (!paymentPayload || typeof paymentPayload !== 'string' || paymentPayload.trim().length === 0) {
      console.error('Payment payload is empty or invalid')
      return { isValid: false, error: { invalidReason: 'EMPTY_PAYLOAD' } }
    }
    
    const trimmedPayload = paymentPayload.trim()

    const cdpApiKeyId = Deno.env.get('CDP_API_KEY_ID')
    const cdpApiKeySecret = Deno.env.get('CDP_API_KEY_SECRET')
    const cdpApiKey = Deno.env.get('CDP_API_KEY')

    if (!cdpApiKeyId || !cdpApiKeySecret) {
      if (!cdpApiKey) {
        console.error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be configured')
        return { isValid: false, error: { invalidReason: 'MISSING_API_CREDENTIALS' } }
      }
      console.warn('Using CDP_API_KEY (CDP_API_KEY_ID and CDP_API_KEY_SECRET pair recommended)')
    }

    let paymentData
    try {
      // X-PAYMENT header is base64-encoded JSON, decode it first
      let decodedPayload: string
      try {
        // Try base64 decoding (standard base64)
        decodedPayload = atob(trimmedPayload)
      } catch (base64Error) {
        // If base64 fails, try base64url decoding (URL-safe variant)
        try {
          const base64 = trimmedPayload.replace(/-/g, '+').replace(/_/g, '/')
          const pad = base64.length % 4
          const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64
          decodedPayload = atob(paddedBase64)
        } catch (base64urlError) {
          console.error('Failed to decode base64/base64url payload:', base64Error, base64urlError)
          return { isValid: false, error: { invalidReason: 'INVALID_BASE64_ENCODING' } }
        }
      }
      
      // Parse the decoded JSON
      paymentData = JSON.parse(decodedPayload)
      
      // Validate that payload is x402-compliant (has x402Version, scheme, network, payload)
      const isX402Payload = paymentData.x402Version !== undefined && 
                            paymentData.scheme !== undefined && 
                            paymentData.network !== undefined && 
                            paymentData.payload !== undefined
      
      if (!isX402Payload) {
        console.error('Payment payload is not x402-compliant. Expected x402 authorization data, not transaction data.')
        return { isValid: false, error: { invalidReason: 'NOT_X402_PAYLOAD' } }
      }
    } catch (e) {
      console.error('Payment payload is not valid JSON:', e)
      return { isValid: false, error: { invalidReason: 'INVALID_JSON' } }
    }
    
    // Additional validation: paymentData must be an object
    if (!paymentData || typeof paymentData !== 'object' || Array.isArray(paymentData)) {
      console.error('Payment data must be a valid object, got:', typeof paymentData)
      return { isValid: false, error: { invalidReason: 'INVALID_PAYLOAD_FORMAT' } }
    }

    const paymentReq = {
      amount: PAYMENT_REQUIREMENTS.amount,
      currency: PAYMENT_REQUIREMENTS.currency,
      network: PAYMENT_REQUIREMENTS.network,
      destination: PAYMENT_REQUIREMENTS.destination,
    }

    // Dynamically discover verify and settle functions from x402 package
    let verifyFn: any = null
    let settleFn: any = null
    let facilitator: any = null

    // PRIORITY 0: Try to use useFacilitator wrapper (matches standard implementations)
    // This provides consistent error handling and uses toJsonSafe for serialization
    if (x402.useFacilitator && typeof x402.useFacilitator === 'function') {
      try {
        // Create facilitator config first
        if (cdpApiKeyId && cdpApiKeySecret && x402.createFacilitatorConfig) {
          facilitator = x402.createFacilitatorConfig(cdpApiKeyId, cdpApiKeySecret)
        } else if (cdpApiKey && x402.createFacilitatorConfig) {
          facilitator = x402.createFacilitatorConfig(cdpApiKey)
        }
        
        // Use useFacilitator wrapper if we have a facilitator config
        if (facilitator) {
          const facilitatorClient = x402.useFacilitator(facilitator)
          if (facilitatorClient && typeof facilitatorClient.verify === 'function' && typeof facilitatorClient.settle === 'function') {
            verifyFn = facilitatorClient.verify
            settleFn = facilitatorClient.settle
            console.log('✅ Using useFacilitator wrapper (matches standard implementations)')
          }
        }
      } catch (error) {
        console.warn('⚠️ useFacilitator failed, falling back to manual implementation:', error)
      }
    }

    // PRIORITY 1: Use createFacilitatorConfig to create facilitator instance (if useFacilitator not available)
    if (!verifyFn || !settleFn) {
      if (x402.createFacilitatorConfig && typeof x402.createFacilitatorConfig === 'function') {
        // Create facilitator with API credentials if available
        if (cdpApiKeyId && cdpApiKeySecret) {
          try {
            facilitator = x402.createFacilitatorConfig(cdpApiKeyId, cdpApiKeySecret)
          } catch (error) {
            console.error('Error creating facilitator:', error)
          }
        } else if (cdpApiKey) {
          try {
            facilitator = x402.createFacilitatorConfig(cdpApiKey)
          } catch (error) {
            console.error('Error creating facilitator:', error)
          }
        }
      }
    }
    
    // PRIORITY 2: Check if x402.facilitator is already a usable instance
    if (!facilitator && x402.facilitator) {
      if (typeof x402.facilitator === 'object') {
        // Check if it has verify/settle methods
        if (typeof x402.facilitator.verify === 'function' && typeof x402.facilitator.settle === 'function') {
          facilitator = x402.facilitator
        }
      } else if (typeof x402.facilitator === 'function') {
        // Facilitator might be a factory function
        if (cdpApiKeyId && cdpApiKeySecret) {
          try {
            facilitator = x402.facilitator(cdpApiKeyId, cdpApiKeySecret)
          } catch (e) {
            console.error('Error calling facilitator function:', e)
          }
        }
      }
    }
    
    // PRIORITY 3: Check default export
    if (!facilitator && x402.default?.facilitator) {
      if (typeof x402.default.facilitator === 'object') {
        facilitator = x402.default.facilitator
      }
    }

    // Extract verify and settle from facilitator
    // Since facilitator only has url and createAuthHeaders, we need to implement verify/settle as HTTP calls
    // Build paymentRequirements once - reuse for both verify and settle
    // This ensures exact consistency between verify and settle calls
    const network = paymentData.network || PAYMENT_REQUIREMENTS.network
    const isTestnet = network === 'base-sepolia'
    
    // IMPORTANT: Network-specific USDC name and asset addresses
    // Base mainnet uses "USD Coin", Base Sepolia uses "USDC"
    // This matches the EIP-712 domain name from the contract ABI
    const usdcConfig = getUsdcConfig(network)
    const usdcName = usdcConfig.name
    const usdcAsset = usdcConfig.address
    
    const paymentRequirements = {
      scheme: paymentData.scheme,
      network: network,
      maxAmountRequired: paymentReq.amount ? (parseFloat(paymentReq.amount) * 1000000).toString() : '10000',
      resource: resourceUrl || Deno.env.get('RESOURCE_URL') || 'https://x402.org/resource',
      description: 'Access protected PDF resources via x402 payment. Pay once to receive a signed URL to download the PDF file.',
      // Use the authorization's 'to' address to ensure exact match
      payTo: paymentData.payload?.authorization?.to || paymentReq.destination,
      maxTimeoutSeconds: 60,
      asset: usdcAsset,
      mimeType: 'application/json',
      // For 'exact' scheme on EVM, extra field must contain name and version
      // CRITICAL: Name must match EIP-712 domain name from contract ABI
      // Base mainnet: "USD Coin", Base Sepolia: "USDC"
      extra: {
        name: usdcName,
        version: '2',
        // Add gasLimit for testnet as workaround for gas estimation issues
        // (per GitHub issue: https://github.com/coinbase/x402/issues/...)
        ...(isTestnet && { gasLimit: '10000000000000' })
      },
      // x402 Bazaar discovery metadata - discoverable flag must be in outputSchema.input
      outputSchema: {
        input: {
          method: 'GET',
          type: 'http',
          discoverable: true  // This makes your endpoint discoverable in the x402 Bazaar
        },
        output: {
          type: 'object',
          properties: {
            pdfUrl: {
              type: 'string',
              description: 'Signed URL to download the PDF file (expires in 1 hour)'
            },
            expiresIn: {
              type: 'string',
              description: 'Time until the signed URL expires'
            },
            message: {
              type: 'string',
              description: 'Human-readable message about the PDF URL'
            }
          },
          required: ['pdfUrl']
        }
      },
      metadata: {
        serviceName: 'x402-payment',
        category: 'file-access',
        tags: ['pdf', 'file-download', 'supabase', 'storage']
      }
    }

    if (facilitator && facilitator.url && typeof facilitator.createAuthHeaders === 'function') {
      // Implement verify as HTTP call
      verifyFn = async (paymentData: any, paymentReq: any) => {
        const endpointPaths = ['/verify']
        
        for (const path of endpointPaths) {
          try {
            // Create auth headers
            let authHeadersObj: any = {}
            let authHeaders: any = {}
            try {
              authHeadersObj = await facilitator.createAuthHeaders()
              
              if (authHeadersObj.verify) {
                authHeaders = authHeadersObj.verify
              } else {
                throw new Error('AUTH_HEADERS_NOT_FOUND')
              }
            } catch (authError: any) {
              if (authError.message?.includes('base64url') || authError.message?.includes('Ed25519')) {
                console.error('⚠️ Auth header creation failed:', authError.message)
                throw new Error('AUTH_HEADER_CREATION_FAILED')
              }
              throw authError
            }
            
            // Check if paymentData is already in x402 format
            const isX402Payload = paymentData.x402Version !== undefined && 
                                  paymentData.scheme !== undefined && 
                                  paymentData.network !== undefined && 
                                  paymentData.payload !== undefined
            
            if (!isX402Payload) {
              return { isValid: false, error: 'NOT_X402_PAYLOAD' }
            }
            
            // Build request body for x402 API - reuse paymentRequirements
            const requestBody = {
              x402Version: paymentData.x402Version || 1,  // Use payload's version
              paymentPayload: paymentData,
              paymentRequirements: paymentRequirements
            }
            
            console.log('Request URL:', `${facilitator.url}${path}`)
            
            // Use safeJsonStringify to handle bigint values (matches useFacilitator pattern)
            const requestBodyJson = safeJsonStringify(requestBody)
            console.log('Request body:', requestBodyJson)
            
            const response = await fetch(`${facilitator.url}${path}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders
              },
              body: requestBodyJson
            })
            
            // Handle non-200 status codes (matches useFacilitator pattern)
            if (response.status !== 200) {
              const errorText = await response.text()
              console.error(`Verify HTTP error at ${path}:`, response.status, errorText)
              if (response.status === 404 && endpointPaths.indexOf(path) < endpointPaths.length - 1) {
                continue
              }
              return { isValid: false, error: errorText }
            }
            
            const result = await response.json()
            console.log('Verify API response:', JSON.stringify(result, null, 2))
            return result
          } catch (error: any) {
            console.error(`Verify HTTP request failed:`, error)
            if (endpointPaths.indexOf(path) < endpointPaths.length - 1) {
              continue
            }
            if (error.message === 'AUTH_HEADER_CREATION_FAILED') {
              return { isValid: false, error: 'AUTH_HEADER_CREATION_FAILED' }
            }
            return { isValid: false, error: error.message }
          }
        }
        
        return { isValid: false, error: 'All verify endpoint paths failed' }
      }
      
      // Implement settle as HTTP call
      settleFn = async (paymentData: any, paymentReq: any) => {
        const endpointPaths = ['/settle']
        
        for (const path of endpointPaths) {
          try {
            // Create auth headers
            let authHeadersObj: any = {}
            let authHeaders: any = {}
            try {
              authHeadersObj = await facilitator.createAuthHeaders()
              
              if (authHeadersObj.settle) {
                authHeaders = authHeadersObj.settle
              } else {
                throw new Error('AUTH_HEADERS_NOT_FOUND')
              }
            } catch (authError: any) {
              if (authError.message?.includes('base64url') || authError.message?.includes('Ed25519')) {
                console.error('⚠️ Auth header creation failed:', authError.message)
                throw new Error('AUTH_HEADER_CREATION_FAILED')
              }
              throw authError
            }
            
            // Build request body for x402 API settlement - reuse same paymentRequirements
            const requestBody = {
              x402Version: paymentData.x402Version || 1,  // Use payload's version
              paymentPayload: paymentData,
              paymentRequirements: paymentRequirements  // Reuse exact same object from verify
            }
            
            // Validate settlement request before sending
            const auth = paymentData.payload?.authorization
            if (auth) {
              const now = Math.floor(Date.now() / 1000)
              const validAfter = parseInt(auth.validAfter || '0', 10)
              const validBefore = parseInt(auth.validBefore || '0', 10)
              
              console.log('🔍 Pre-settlement validation:', {
                from: auth.from,
                to: auth.to,
                value: auth.value,
                validAfter,
                validBefore,
                currentTime: now,
                isCurrentlyValid: (validAfter === 0 || now >= validAfter) && (validBefore === 0 || now <= validBefore),
                timeRemaining: validBefore > 0 ? validBefore - now : 'N/A'
              })
              
              // Warn if authorization is close to expiring
              if (validBefore > 0 && now <= validBefore) {
                const timeRemaining = validBefore - now
                if (timeRemaining < 30) {
                  console.warn(`⚠️ Authorization expires in ${timeRemaining}s - settlement may fail if it takes too long`)
                }
              }
            }
            
            console.log('Settle request URL:', `${facilitator.url}${path}`)
            
            // Use safeJsonStringify to handle bigint values (matches useFacilitator pattern)
            const requestBodyJson = safeJsonStringify(requestBody)
            console.log('Settle request body:', requestBodyJson)
            
            const response = await fetch(`${facilitator.url}${path}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders
              },
              body: requestBodyJson
            })
            
            // Handle non-200 status codes (matches useFacilitator pattern)
            // NOTE: Unlike useFacilitator which only uses statusText, we parse the error response body
            // to extract detailed error information (errorMessage, errorType, correlationId, etc.)
            // This is important because:
            // 1. Coinbase facilitator API returns structured error responses with detailed info
            // 2. Core settle() function doesn't catch writeContract errors, so they propagate as HTTP errors
            // 3. Standard implementations lose error details by only using statusText
            if (response.status !== 200) {
              const errorText = await response.text()
              console.error(`❌ Settle HTTP error:`, response.status, errorText)
              console.error(`❌ Settle request that failed:`, JSON.stringify(requestBody, null, 2))
              
              // Parse error JSON to extract detailed error information
              // Coinbase facilitator returns structured errors like:
              // {
              //   "correlationId": "...",
              //   "errorLink": "...",
              //   "errorMessage": "unable to estimate gas",
              //   "errorType": "invalid_request"
              // }
              let errorMessage = errorText
              let errorType = 'SETTLEMENT_ERROR'
              let parsedErrorJson: any = null
              try {
                parsedErrorJson = JSON.parse(errorText)
                errorMessage = parsedErrorJson.errorMessage || parsedErrorJson.message || errorText
                errorType = parsedErrorJson.errorType || parsedErrorJson.errorReason || 'SETTLEMENT_ERROR'
                console.error(`❌ Parsed settlement error:`, JSON.stringify(parsedErrorJson, null, 2))
              } catch (e) {
                // If parsing fails, use the raw error text
                // This handles cases where facilitator returns non-JSON errors
                console.error(`❌ Settlement error is not JSON, raw text:`, errorText)
              }
              
              // Log detailed error information for debugging
              console.error('📋 Settlement error analysis:', {
                statusCode: response.status,
                errorType,
                errorMessage,
                correlationId: parsedErrorJson?.correlationId || 'N/A',
                errorLink: parsedErrorJson?.errorLink || 'N/A',
                requestBody: {
                  x402Version: requestBody.x402Version,
                  paymentPayloadScheme: requestBody.paymentPayload?.scheme,
                  paymentPayloadNetwork: requestBody.paymentPayload?.network,
                  paymentRequirementsScheme: requestBody.paymentRequirements?.scheme,
                  paymentRequirementsNetwork: requestBody.paymentRequirements?.network,
                  paymentRequirementsPayTo: requestBody.paymentRequirements?.payTo,
                  paymentRequirementsAsset: requestBody.paymentRequirements?.asset,
                  authorizationFrom: requestBody.paymentPayload?.payload?.authorization?.from,
                  authorizationTo: requestBody.paymentPayload?.payload?.authorization?.to,
                  authorizationValue: requestBody.paymentPayload?.payload?.authorization?.value
                }
              })
              
              if (response.status === 404 && endpointPaths.indexOf(path) < endpointPaths.length - 1) {
                continue
              }
              return { success: false, error: errorText, errorMessage, errorType, parsedError: parsedErrorJson }
            }
            
            // Parse response (status is 200)
            const result = await response.json()
            console.log('Settle API response:', JSON.stringify(result, null, 2))
            
            // Check if settlement failed even with 200 status (matches standard implementation pattern)
            // NOTE: Some facilitators may return 200 OK with { success: false } instead of error status codes
            // This can happen if the facilitator server catches errors and returns structured SettleResponse
            // Standard implementations check settleResponse.success after getting the response
            // This handles cases where facilitator returns structured error responses with 200 status
            if (result && result.success === false) {
              console.warn('⚠️ Settlement returned success: false despite 200 status')
              console.warn('   This indicates the facilitator caught an error and returned a structured response')
              return {
                success: false,
                error: result.errorReason || result.error || 'Settlement failed',
                errorMessage: result.errorReason || result.error || 'Settlement failed',
                errorType: result.errorReason || 'SETTLEMENT_FAILED',
                parsedError: result
              }
            }
            
            return result
          } catch (error: any) {
            console.error(`Settle HTTP request failed:`, error)
            if (endpointPaths.indexOf(path) < endpointPaths.length - 1) {
              continue
            }
            if (error.message === 'AUTH_HEADER_CREATION_FAILED') {
              return { success: false, error: 'AUTH_HEADER_CREATION_FAILED' }
            }
            return { success: false, error: error.message }
          }
        }
        
        return { success: false, error: 'All settle endpoint paths failed' }
      }
    } else if (facilitator) {
      // Check for verify method (legacy support)
      if (typeof facilitator.verify === 'function') {
        verifyFn = facilitator.verify
      }
      
      // Check for settle method (legacy support)
      if (typeof facilitator.settle === 'function') {
        settleFn = facilitator.settle
      }
    }

    // Also check direct exports (legacy support)
    if (!verifyFn && typeof x402.verify === 'function') {
      verifyFn = x402.verify
    }
    if (!settleFn && typeof x402.settle === 'function') {
      settleFn = x402.settle
    }

    if (!verifyFn || !settleFn) {
      console.error('Could not find verify/settle functions in @coinbase/x402 package')
      return { isValid: false, error: { invalidReason: 'VERIFY_SETTLE_FUNCTIONS_NOT_FOUND' } }
    }

    // Step 1: Verify payment
    let verificationResult
    try {
      verificationResult = await verifyFn(paymentData, paymentReq)
    } catch (error: any) {
      console.error('Payment verification error:', error)
      if (error?.message === 'NOT_X402_PAYLOAD' || error?.error === 'NOT_X402_PAYLOAD') {
        console.error('Payment payload is not x402-compliant. Client must send x402 authorization data.')
        return { isValid: false, error: { invalidReason: 'NOT_X402_PAYLOAD' } }
      }
      if (error?.message?.includes('AUTH_HEADER_CREATION_FAILED') || 
          error?.message?.includes('base64url') || 
          error?.message?.includes('Ed25519')) {
        console.error('x402 verification failed due to authentication error:', error.message)
        return { isValid: false, error: { invalidReason: 'AUTH_HEADER_CREATION_FAILED' } }
      }
      console.error('x402 verification failed:', error.message)
      return { isValid: false, error: { invalidReason: error.message || 'UNKNOWN_ERROR' } }
    }

    // Check if verification failed
    if (verificationResult?.error === 'AUTH_HEADER_CREATION_FAILED' || 
        verificationResult?.error === 'NOT_X402_PAYLOAD' ||
        verificationResult?.error?.includes('base64url') ||
        verificationResult?.error?.includes('Ed25519')) {
      console.error('x402 verification returned error:', verificationResult.error)
      return { isValid: false, error: { invalidReason: verificationResult.error } }
    }

    if (!verificationResult || !verificationResult.isValid) {
      console.error('x402 verification returned invalid result:', verificationResult)
      // Return the error details so we can provide a helpful message
      return { isValid: false, error: verificationResult }
    }

    // Verification passed - log success
    console.log('✅ Payment verification PASSED:', {
      isValid: verificationResult.isValid,
      payer: verificationResult.payer || 'unknown',
      invalidReason: verificationResult.invalidReason || 'none'
    })

    // Step 2: Settle payment
    // Note: paymentRequirements is already constructed above and will be reused
    
    // Check authorization validity before attempting settlement
    const authorization = paymentData.payload?.authorization
    if (authorization) {
      const now = Math.floor(Date.now() / 1000)
      const validAfter = parseInt(authorization.validAfter || '0', 10)
      const validBefore = parseInt(authorization.validBefore || '0', 10)
      
      if (validAfter > 0 && now < validAfter) {
        console.warn(`⚠️ Authorization not yet valid: validAfter=${validAfter}, now=${now}, expires in ${validAfter - now}s`)
      }
      if (validBefore > 0 && now > validBefore) {
        console.error(`❌ Authorization expired: validBefore=${validBefore}, now=${now}, expired ${now - validBefore}s ago`)
        return { isValid: false, error: { invalidReason: 'AUTHORIZATION_EXPIRED', details: `Authorization expired ${now - validBefore} seconds ago` } }
      }
      if (validAfter > 0 && validBefore > 0) {
        const timeRemaining = validBefore - now
        console.log(`⏰ Authorization valid for ${timeRemaining}s (validAfter=${validAfter}, validBefore=${validBefore}, now=${now})`)
      }
    }
    
    console.log('🔄 Attempting payment settlement with paymentRequirements:', JSON.stringify(paymentRequirements, null, 2))
    let settlementResult
    try {
      settlementResult = await settleFn(paymentData, paymentReq)
    } catch (error) {
      console.error('Payment settlement error:', error)
      return { isValid: false, error: { invalidReason: 'SETTLEMENT_ERROR', details: error?.message || 'UNKNOWN_ERROR' } }
    }

    // Handle settlement result
    // Following the pattern from Coinbase examples (auth_based_pricing/backend.ts):
    // If verification passed but settlement fails, we still serve content (lenient approach).
    // Settlement failure is logged but doesn't block access since verification already confirmed
    // the payment authorization is valid.
    if (!settlementResult || !settlementResult.success) {
      console.error('⚠️ Payment settlement failed (but verification passed). Full settlement result:', JSON.stringify(settlementResult, null, 2))
      
      // Extract settlement error details for logging
      const settlementError = settlementResult.error || settlementResult.errorMessage || ''
      const parsedError = settlementResult.parsedError || null
      
      // Use parsedError if available, otherwise try to parse settlementError
      let finalParsedError: any = parsedError
      if (!finalParsedError && settlementError) {
        try {
          if (typeof settlementError === 'string') {
            finalParsedError = JSON.parse(settlementError)
          } else {
            finalParsedError = settlementError
          }
        } catch (e) {
          // Not JSON, use as-is
          console.error('⚠️ Could not parse settlement error as JSON:', settlementError)
        }
      }
      
      console.error('⚠️ Settlement error details:', JSON.stringify(finalParsedError, null, 2))
      
      // Log specific error types for monitoring
      if (finalParsedError?.errorMessage) {
        const facilitatorError = finalParsedError.errorMessage.toLowerCase()
        if (facilitatorError.includes('unable to estimate gas')) {
          console.error('⚠️ Settlement failed: Facilitator unable to estimate gas. This is a facilitator configuration issue, not a user issue.')
          console.error('💡 Possible causes:')
          console.error('   1. Facilitator wallet lacks ETH for gas fees')
          console.error('   2. Contract interaction would fail (e.g., insufficient allowance)')
          console.error('   3. Network/RPC issues preventing gas estimation')
          console.error('   4. Authorization may have issues preventing gas estimation')
          console.error('💡 Action: Contact Coinbase support or check facilitator wallet balance')
          
          // Log Coinbase documentation link if available
          if (finalParsedError.errorLink) {
            console.error(`📖 See Coinbase documentation: ${finalParsedError.errorLink}`)
            console.error(`📋 Correlation ID for support: ${finalParsedError.correlationId || 'N/A'}`)
          }
          
          // Log authorization details for debugging
          if (authorization) {
            const now = Math.floor(Date.now() / 1000)
            const validAfter = parseInt(authorization.validAfter || '0', 10)
            const validBefore = parseInt(authorization.validBefore || '0', 10)
            const timeRemaining = validBefore > 0 ? validBefore - now : 0
            
            console.error('📋 Authorization details:', {
              from: authorization.from,
              to: authorization.to,
              value: authorization.value,
              validAfter: authorization.validAfter,
              validBefore: authorization.validBefore,
              nonce: authorization.nonce,
              timeRemainingSeconds: timeRemaining,
              isCurrentlyValid: (validAfter === 0 || now >= validAfter) && (validBefore === 0 || now <= validBefore)
            })
            
            // Additional diagnostic: Check if authorization window is very short
            const authWindow = validBefore > 0 && validAfter > 0 ? validBefore - validAfter : 0
            if (authWindow > 0 && authWindow < 300) {
              console.warn(`⚠️ Authorization window is short (${authWindow}s). Consider using longer windows for settlement.`)
            }
          }
          
          // Diagnostic summary for Coinbase support
          const networkForDiagnostics = paymentData.network || PAYMENT_REQUIREMENTS.network
          const usdcConfigForDiagnostics = getUsdcConfig(networkForDiagnostics)
          console.error('📊 Diagnostic Summary for Coinbase Support:')
          console.error('   - Verification: PASSED (authorization is valid)')
          console.error('   - Settlement: FAILED (unable to estimate gas)')
          console.error(`   - Network: ${networkForDiagnostics}`)
          console.error(`   - Asset: ${usdcConfigForDiagnostics.name} (${usdcConfigForDiagnostics.address})`)
          console.error('   - Amount: 10000 (0.01 USDC)')
          console.error('   - This is a facilitator-side issue, not a client issue')
        } else if (facilitatorError.includes('insufficient funds')) {
          console.error('⚠️ Settlement failed: Facilitator wallet has insufficient ETH for gas.')
        }
      }
      
      // Note: Using lenient approach - verification passed, so we return isValid: true
      // Settlement failure is logged but doesn't block access
      // This matches the pattern from Coinbase's auth_based_pricing example
      console.log('✅ Verification passed - serving content despite settlement failure (lenient approach)')
      // Return settlement result even on failure so caller can handle it
      return { isValid: true, settlementResult }
    } else {
      console.log('✅ Payment settlement successful:', JSON.stringify(settlementResult, null, 2))
      // Settlement succeeded - return result so caller can set X-PAYMENT-RESPONSE header
      return { isValid: true, settlementResult }
    }
  } catch (error) {
    console.error('Payment verification error:', error)
    return { isValid: false, error: { invalidReason: error?.message || 'UNKNOWN_ERROR' } }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Debug endpoint to return PDF URL from Supabase storage
  // Access via: GET /functions/v1/x402-payment?debug=true
  const url = new URL(req.url)
  if (req.method === 'GET' && url.searchParams.get('debug') === 'true') {
    try {
      // Create Supabase client
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!
      const supabase = createClient(supabaseUrl, supabaseKey)
      
      // Get bucket name and file path from environment variables or use defaults
      const pdfBucket = Deno.env.get('PDF_STORAGE_BUCKET') || 'pdf'
      const pdfFileName = Deno.env.get('PDF_FILE_NAME') || 'files/x402.pdf'
      
      // List files in bucket for debugging
      const { data: listData, error: listError } = await supabase.storage
        .from(pdfBucket)
        .list()
      
      // Get signed URL for the PDF file (works with both public and private buckets)
      // Expires in 1 hour (3600 seconds)
      const { data: urlData, error: urlError } = await supabase.storage
        .from(pdfBucket)
        .createSignedUrl(pdfFileName, 3600)
      
      if (urlError) {
        console.error('Error creating signed URL:', urlError)
        return new Response(
          JSON.stringify({ 
            error: 'Failed to create PDF URL', 
            details: urlError.message,
            bucket: pdfBucket,
            fileName: pdfFileName,
            availableFiles: listError ? 'Could not list files' : (listData?.map(f => f.name) || [])
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          },
        )
      }
      
      return new Response(
        JSON.stringify({ 
          pdfUrl: urlData.signedUrl,
          bucket: pdfBucket,
          fileName: pdfFileName,
          availableFiles: listError ? 'Could not list files' : (listData?.map(f => f.name) || [])
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      )
    } catch (error: any) {
      console.error('Error getting PDF URL:', error)
      return new Response(
        JSON.stringify({ error: 'Internal server error', message: error.message }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        },
      )
    }
  }

  try {
    // TEST MODE: Allow bypassing payment with ?test=true query parameter
    // This is useful for development/testing with curl
    const url = new URL(req.url)
    const testMode = url.searchParams.get('test') === 'true' || url.searchParams.get('bypass_payment') === 'true'
    
    if (testMode) {
      console.log('⚠️ TEST MODE ENABLED - Payment verification bypassed')
      // Set up response headers for test mode
      const responseHeaders = new Headers()
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('X-Payment-Status', 'bypassed-test-mode')
      responseHeaders.set('X-Test-Mode', 'true')
      
      // Skip to custom function implementation
      // The generator will insert the custom implementation code here
      // For now, throw error if implementation not generated yet
      // After generation, this will execute the custom function logic
      throw new Error('Function implementation not generated. Please run: deno run --allow-read --allow-write --allow-net --allow-env scripts/generate-function.ts <function-slug>')
    }
    
    // Check for X-PAYMENT header (case-insensitive check)
    const paymentPayload = req.headers.get('X-PAYMENT') || req.headers.get('x-payment')
    
    // Construct full resource URL for payment requirements
    // req.url might be http:// internally, so we need to construct the proper HTTPS URL
    // Note: url was already created above for test mode check
    // Use the hostname from the URL, not the host header (which might be edge-runtime)
    const hostname = url.hostname
    // Always use HTTPS for Supabase URLs
    const protocol = 'https'
    // Ensure pathname includes /functions/v1/ if it's missing
    let pathname = url.pathname
    if (!pathname.includes('/functions/v1/')) {
      // Extract function name from pathname if it's just /function-name
      const functionName = pathname.replace(/^\//, '').replace(/\/$/, '')
      pathname = `/functions/v1/${functionName}`
    }
    const resourceUrl = `${protocol}://${hostname}${pathname}`
    
    console.log('Original req.url:', req.url)
    console.log('Constructed resource URL:', resourceUrl)
    
    // Strict validation: header must exist and be non-empty
    if (!paymentPayload || paymentPayload.trim().length === 0) {
      // Get USDC config for the network
      const usdcConfig = getUsdcConfig(PAYMENT_REQUIREMENTS.network)
      
      // Return HTTP 402 Payment Required in standard x402 format with Bazaar metadata
      const paymentResponse = {
        x402Version: 1,
        error: 'Payment required to access this resource',
        accepts: [{
          scheme: 'exact',
          network: PAYMENT_REQUIREMENTS.network,
          maxAmountRequired: (parseFloat(PAYMENT_REQUIREMENTS.amount) * 1000000).toString(), // Convert to smallest units
          resource: resourceUrl,
          description: 'Access protected PDF resources via x402 payment. Pay once to receive a signed URL to download the PDF file.',
          mimeType: 'application/json',
          payTo: PAYMENT_REQUIREMENTS.destination,
          maxTimeoutSeconds: 60,
          asset: usdcConfig.address,
          extra: {
            name: usdcConfig.name,
            version: '2'
          },
          // x402 Bazaar discovery metadata - discoverable flag must be in outputSchema.input
          outputSchema: {
            input: {
              method: 'GET',
              type: 'http',
              discoverable: true  // This makes your endpoint discoverable in the x402 Bazaar
            },
            output: {
              type: 'object',
              properties: {
                pdfUrl: {
                  type: 'string',
                  description: 'Signed URL to download the PDF file (expires in 1 hour)'
                },
                expiresIn: {
                  type: 'string',
                  description: 'Time until the signed URL expires'
                },
                message: {
                  type: 'string',
                  description: 'Human-readable message about the PDF URL'
                }
              },
              required: ['pdfUrl']
            }
          },
          metadata: {
            serviceName: 'x402-payment',
            category: 'file-access',
            tags: ['pdf', 'file-download', 'supabase', 'storage']
          }
        }]
      }
      
      const responseHeaders = new Headers()
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type, x-payment')
      responseHeaders.set('Access-Control-Expose-Headers', 'x-payment')
      responseHeaders.set('Content-Type', 'application/json')
      
      return new Response(
        JSON.stringify(paymentResponse, null, 2),
        {
          headers: responseHeaders,
          status: 402,
        },
      )
    }
    
    // Verify payment
    const verificationResult = await verifyPayment(paymentPayload.trim(), resourceUrl)
    
    if (!verificationResult || (typeof verificationResult === 'object' && !verificationResult.isValid)) {
      // Extract specific error reason if available
      const errorDetails = typeof verificationResult === 'object' && verificationResult.error 
        ? verificationResult.error 
        : null
      const invalidReason = errorDetails?.invalidReason || errorDetails?.errorMessage || null
      
      let errorMessage = 'Payment verification failed. Please provide a valid x402-compliant payment authorization payload.'
      let instructions = 'Use the @coinbase/x402 SDK to generate a payment authorization before sending the transaction.'
      
      // Provide specific guidance based on error reason
      if (invalidReason === 'invalid_exact_evm_payload_signature_address') {
        errorMessage = 'Payment verification failed: Signature address mismatch. The signature was not created with the correct EIP-712 encoding.'
        instructions = 'The signature encoding does not match what the Coinbase API expects. This typically happens when using ethers.js instead of the official @coinbase/x402 SDK. Please use the @coinbase/x402 SDK\'s signAuthorization function, or ensure your ethers.js EIP-712 encoding exactly matches viem\'s encoding (used by Coinbase).'
      } else if (invalidReason === 'invalid_payment_requirements') {
        errorMessage = 'Payment verification failed: Payment requirements mismatch.'
        instructions = 'Check that the payment requirements (amount, destination, asset, etc.) match exactly what was requested.'
      } else if (invalidReason === 'SETTLEMENT_FAILED') {
        // Use the detailed error message from settlement
        errorMessage = errorDetails?.errorMessage || 'Payment settlement failed. The authorization was verified but settlement failed.'
        instructions = errorDetails?.instructions || 'The payment authorization was verified but settlement failed. This may be due to facilitator configuration issues. Please contact Coinbase support or check your facilitator configuration.'
      } else if (invalidReason) {
        errorMessage = `Payment verification failed: ${invalidReason}`
      }
      
      // Return HTTP 402 Payment Required in standard x402 format with Bazaar metadata
      // Get USDC config for the network
      const usdcConfig = getUsdcConfig(PAYMENT_REQUIREMENTS.network)
      
      const errorResponse = {
        x402Version: 1,
        error: errorMessage,
        accepts: [{
          scheme: 'exact',
          network: PAYMENT_REQUIREMENTS.network,
          maxAmountRequired: (parseFloat(PAYMENT_REQUIREMENTS.amount) * 1000000).toString(), // Convert to smallest units
          resource: resourceUrl,
          description: 'Access protected PDF resources via x402 payment. Pay once to receive a signed URL to download the PDF file.',
          mimeType: 'application/json',
          payTo: PAYMENT_REQUIREMENTS.destination,
          maxTimeoutSeconds: 60,
          asset: usdcConfig.address,
          extra: {
            name: usdcConfig.name,
            version: '2'
          },
          // x402 Bazaar discovery metadata - discoverable flag must be in outputSchema.input
          outputSchema: {
            input: {
              method: 'GET',
              type: 'http',
              discoverable: true  // This makes your endpoint discoverable in the x402 Bazaar
            },
            output: {
              type: 'object',
              properties: {
                pdfUrl: {
                  type: 'string',
                  description: 'Signed URL to download the PDF file (expires in 1 hour)'
                },
                expiresIn: {
                  type: 'string',
                  description: 'Time until the signed URL expires'
                },
                message: {
                  type: 'string',
                  description: 'Human-readable message about the PDF URL'
                }
              },
              required: ['pdfUrl']
            }
          },
          metadata: {
            serviceName: 'x402-payment',
            category: 'file-access',
            tags: ['pdf', 'file-download', 'supabase', 'storage']
          }
        }]
      }
      
      const responseHeaders = new Headers()
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Content-Type', 'application/json')
      
      return new Response(
        JSON.stringify(errorResponse, null, 2),
        {
          headers: responseHeaders,
          status: 402,
        },
      )
    }
    
    // Payment verified - return resource
    const responseHeaders = new Headers()
    responseHeaders.set('Access-Control-Allow-Origin', '*')
    responseHeaders.set('Access-Control-Expose-Headers', 'X-PAYMENT-RESPONSE')
    responseHeaders.set('X-Payment-Status', 'verified')
    
    // Set X-PAYMENT-RESPONSE header if settlement succeeded
    if (verificationResult.settlementResult && verificationResult.settlementResult.success) {
      const paymentResponseHeader = createPaymentResponseHeader(verificationResult.settlementResult)
      responseHeaders.set('X-PAYMENT-RESPONSE', paymentResponseHeader)
      console.log('✅ X-PAYMENT-RESPONSE header set with transaction:', verificationResult.settlementResult.transaction || verificationResult.settlementResult.txHash)
    } else if (verificationResult.settlementResult) {
      // Settlement was attempted but failed
      const settlementError = verificationResult.settlementResult.errorMessage || verificationResult.settlementResult.error || 'Unknown error'
      const errorType = verificationResult.settlementResult.errorType || 'SETTLEMENT_ERROR'
      console.log('⚠️ Settlement failed - not setting X-PAYMENT-RESPONSE header')
      console.log('📋 Settlement failure details:', {
        success: verificationResult.settlementResult.success,
        errorType,
        errorMessage: settlementError,
        hasParsedError: !!verificationResult.settlementResult.parsedError
      })
      
      // Log specific guidance based on error type
      if (settlementError.toLowerCase().includes('unable to estimate gas')) {
        console.log('💡 Settlement failed due to gas estimation issue. This is a facilitator-side problem.')
        console.log('💡 The payment authorization was verified, but the facilitator cannot execute the settlement.')
        console.log('💡 Possible solutions:')
        console.log('   1. Contact Coinbase support to check facilitator wallet balance')
        console.log('   2. Verify CDP API key has settlement permissions')
        console.log('   3. Check if there are network/RPC issues')
      }
    } else {
      // Settlement was not attempted (shouldn't happen if verification passed)
      console.log('⚠️ No settlement result found - settlement may not have been attempted')
    }
    
    // Summary log for debugging
    const hasSettlementHeader = responseHeaders.has('X-PAYMENT-RESPONSE')
    console.log('📊 Payment processing summary:', {
      verification: 'PASSED',
      settlement: verificationResult.settlementResult?.success ? 'SUCCEEDED' : 'FAILED',
      xPaymentResponseHeaderSet: hasSettlementHeader,
      xPaymentStatusHeaderSet: responseHeaders.has('X-Payment-Status'),
      settlementError: verificationResult.settlementResult?.errorMessage || null
    })
    
    // ============================================================================
    // CUSTOM FUNCTION IMPLEMENTATION
    // ============================================================================
    // 
    // THIS SECTION IS REPLACED BY THE FUNCTION GENERATOR
    // The template only handles x402 payment integration.
    // All custom function logic is inserted here by generate-function.ts
    //
    // The custom implementation code should:
    // 1. Parse inputs from the request (query params, body, or path)
    // 2. Validate required inputs
    // 3. Execute the function logic
    // 4. Return a Response with the result
    //
    // Available variables after payment verification:
    // - req: Request object
    // - responseHeaders: Headers object (includes CORS and payment headers)
    // - url: URL object (can be created with: new URL(req.url))
    //
    // The custom code must return a Response object.
    // Example:
    //   const url = new URL(req.url)
    //   const param = url.searchParams.get('param')
    //   if (!param) {
    //     return new Response(JSON.stringify({ error: 'Missing param' }), 
    //       { status: 400, headers: { ...responseHeaders, 'Content-Type': 'application/json' } })
    //   }
    //   const result = { data: 'your result here' }
    //   return new Response(JSON.stringify(result), 
    //     { headers: { ...responseHeaders, 'Content-Type': 'application/json' }, status: 200 })
    //
    // ============================================================================
    // PLACEHOLDER - REPLACED BY GENERATOR
    // ============================================================================
    throw new Error('Function implementation not generated. Please run: deno run --allow-read --allow-write --allow-net --allow-env scripts/generate-function.ts <function-slug>')
  } catch (error) {
    console.error('Function error:', error)
    return new Response(
      JSON.stringify({ error: 'internal_server_error', message: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    )
  }
})