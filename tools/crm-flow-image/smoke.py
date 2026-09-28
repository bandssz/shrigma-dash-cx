#!/usr/bin/env python3
"""CI-only local OCI runtime proof. Creates no publishable receipt or registry call."""
import argparse
from pathlib import Path
import re
import image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    image.test_oci_image(args.archive, args.source_sha, 'crm-flows-oci-ci-proof')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r'CRM_IMAGE_[A-Z_]{1,60}', code) else 'CRM_IMAGE_SMOKE_UNCONFIRMED')
