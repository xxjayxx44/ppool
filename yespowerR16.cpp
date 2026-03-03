#include <node.h>
#include <node_buffer.h>
#include <v8.h>
#include <cstring>
#include <cstdlib>

// Include the optimized yespower code (you need to copy the entire yespower-opt.c content here)
// For brevity, I'll assume you have the full yespower-opt.c code in a header or inline.
// In practice, you'd #include "yespower-opt.c" after setting up the correct defines.

// This is a simplified placeholder – replace with actual yespowerR16 hash function.
// The real implementation would call the yespower function with parameters:
// N=4096, r=16, personalization="Yenten", version=YESPOWER_0_5 or YESPOWER_1_0 (depending on coin)

extern "C" {
    // Declare the yespower function from your optimized C code.
    // This should match the signature in yespower.h.
    int yespower_tls(const uint8_t *src, size_t srclen,
                     const yespower_params_t *params,
                     yespower_binary_t *dst);
}

using namespace v8;

void Hash(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();

    if (args.Length() < 2) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Wrong number of arguments").ToLocalChecked()));
        return;
    }

    if (!args[0]->IsObject() || !args[1]->IsUint32()) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Argument must be (Buffer, nonce)").ToLocalChecked()));
        return;
    }

    Local<Object> headerObj = args[0]->ToObject(isolate->GetCurrentContext()).ToLocalChecked();
    if (!node::Buffer::HasInstance(headerObj)) {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "First argument must be a Buffer").ToLocalChecked()));
        return;
    }

    uint32_t nonce = args[1]->Uint32Value(isolate->GetCurrentContext()).FromJust();

    // Get header data (76 bytes constant + nonce appended later, or full 80 bytes)
    char* headerData = node::Buffer::Data(headerObj);
    size_t headerLen = node::Buffer::Length(headerObj);

    // Build full 80-byte header (76 constant + 4 nonce)
    uint8_t header[80];
    if (headerLen == 76) {
        memcpy(header, headerData, 76);
        header[76] = nonce & 0xff;
        header[77] = (nonce >> 8) & 0xff;
        header[78] = (nonce >> 16) & 0xff;
        header[79] = (nonce >> 24) & 0xff;
    } else if (headerLen == 80) {
        memcpy(header, headerData, 80);
        // replace last 4 bytes with nonce
        header[76] = nonce & 0xff;
        header[77] = (nonce >> 8) & 0xff;
        header[78] = (nonce >> 16) & 0xff;
        header[79] = (nonce >> 24) & 0xff;
    } else {
        isolate->ThrowException(Exception::TypeError(
            String::NewFromUtf8(isolate, "Header must be 76 or 80 bytes").ToLocalChecked()));
        return;
    }

    // Set up yespower parameters for YespowerR16 (Yenten)
    yespower_params_t params = {
        .version = YESPOWER_0_5,   // Check coin's actual version
        .N = 4096,
        .r = 16,
        .pers = (const uint8_t*)"Yenten",
        .perslen = 6
    };

    yespower_binary_t output;
    int result = yespower_tls(header, 80, &params, &output);

    if (result != 0) {
        isolate->ThrowException(Exception::Error(
            String::NewFromUtf8(isolate, "yespower failed").ToLocalChecked()));
        return;
    }

    // Return hash as Buffer
    MaybeLocal<Object> buf = node::Buffer::Copy(isolate, (const char*)output.bytes, 32);
    args.GetReturnValue().Set(buf.ToLocalChecked());
}

void Initialize(Local<Object> exports) {
    NODE_SET_METHOD(exports, "hash", Hash);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
