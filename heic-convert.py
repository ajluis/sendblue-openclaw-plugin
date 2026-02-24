#!/usr/bin/env python3
"""
HEIC/HEIF → JPEG converter for Sendblue media.
Usage: python3 heic-convert.py <input_url_or_path> <output_path>
Downloads if URL, converts HEIC/HEIF to JPEG, copies non-HEIC as-is.
Exit 0 on success, prints output path to stdout.
"""

import sys
import os
import tempfile
import urllib.request
import shutil

def is_heic(data: bytes) -> bool:
    """Check if bytes are HEIC/HEIF by looking for ftyp box signatures."""
    if len(data) < 12:
        return False
    # ftyp box at offset 4
    if data[4:8] == b'ftyp':
        brand = data[8:12]
        heic_brands = [b'heic', b'heix', b'hevc', b'hevx', b'heim', b'heis',
                       b'mif1', b'msf1', b'avif']
        return brand in heic_brands
    return False

def convert_heic_to_jpeg(input_path: str, output_path: str, quality: int = 92) -> str:
    """Convert HEIC to JPEG using pillow-heif."""
    from pillow_heif import register_heif_opener
    from PIL import Image

    register_heif_opener()
    
    img = Image.open(input_path)
    # Handle EXIF rotation
    from PIL import ImageOps
    img = ImageOps.exif_transpose(img)
    # Convert to RGB if needed (HEIC can have alpha)
    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')
    img.save(output_path, 'JPEG', quality=quality)
    return output_path

def main():
    if len(sys.argv) < 3:
        print("Usage: heic-convert.py <input_url_or_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    input_source = sys.argv[1]
    output_path = sys.argv[2]

    # Download if URL
    if input_source.startswith('http://') or input_source.startswith('https://'):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.heic')
        try:
            req = urllib.request.Request(input_source, headers={'User-Agent': 'OpenClaw/1.0'})
            with urllib.request.urlopen(req, timeout=30) as resp:
                shutil.copyfileobj(resp, tmp)
            tmp.close()
            input_path = tmp.name
        except Exception as e:
            print(f"Download failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        input_path = input_source

    # Read first bytes to check format
    with open(input_path, 'rb') as f:
        header = f.read(64)

    if is_heic(header):
        try:
            convert_heic_to_jpeg(input_path, output_path)
            print(output_path)
        except Exception as e:
            print(f"Conversion failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Not HEIC — just copy as-is
        shutil.copy2(input_path, output_path)
        print(output_path)

    # Cleanup temp file if downloaded
    if input_source.startswith('http'):
        try:
            os.unlink(input_path)
        except:
            pass

if __name__ == '__main__':
    main()
