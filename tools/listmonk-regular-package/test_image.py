import hashlib
from pathlib import Path
import tempfile
import unittest
import image


class PackageInventoryTest(unittest.TestCase):
    def fixture(self, folder):
        p=Path(folder);(p/'source').mkdir();(p/'source/main.go').write_bytes(b'package main')
        (p/'SHA256SUMS').write_text(hashlib.sha256(b'package main').hexdigest()+'  source/main.go\n')
        return p

    def test_exact_inventory_and_drift(self):
        with tempfile.TemporaryDirectory() as folder:
            p=self.fixture(folder);image.verify_package(p)
            (p/'source/main.go').write_text('changed')
            with self.assertRaisesRegex(ValueError,'source drift'):image.verify_package(p)

    def test_unlisted_file_is_rejected_before_source_archiving(self):
        with tempfile.TemporaryDirectory() as folder:
            p=self.fixture(folder);(p/'source/unlisted').write_text('extra')
            with self.assertRaisesRegex(ValueError,'inventory mismatch'):image.verify_package(p)

    def test_duplicate_or_missing_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            p=self.fixture(folder);manifest=p/'SHA256SUMS';line=manifest.read_text();manifest.write_text(line+line)
            with self.assertRaisesRegex(ValueError,'Duplicate'):image.verify_package(p)
            manifest.write_text(line);(p/'source/main.go').unlink()
            with self.assertRaises(ValueError):image.verify_package(p)

    def test_symlink_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            p=self.fixture(folder);(p/'source/alias').symlink_to(p/'source',target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'Unsafe package entry'):image.verify_package(p)


if __name__=='__main__':unittest.main()
