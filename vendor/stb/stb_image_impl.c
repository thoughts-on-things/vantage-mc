// Single translation unit that compiles the stb_image implementation.
// stb_image is public-domain (see stb_image.h header for the dual license).
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG          // we only need PNG (block textures); keeps it lean
#define STBI_NO_STDIO          // decode from memory only
#include "stb_image.h"
