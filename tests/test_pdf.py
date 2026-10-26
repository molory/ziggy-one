"""Tests of the PDF export of an exchange: python3 -m unittest discover -s tests"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pdf  # noqa: E402


class PdfTest(unittest.TestCase):
    def test_safe_filename(self):
        self.assertEqual(pdf.safe_filename("question-answer Fix the café / bug ?"), "question-answer-Fix-the-café-bug.pdf")
        self.assertEqual(pdf.safe_filename("../../etc/passwd"), "etc-passwd.pdf")
        self.assertEqual(pdf.safe_filename(None), "conversation.pdf")

    def test_page_forbids_scripts_and_loading(self):
        page = pdf.full_page('Title <b>"', '<p>content</p>')
        self.assertIn("default-src 'none'", page)  # CSP: no script, no external loading
        self.assertIn("<title>Title &lt;b&gt;&quot;</title>", page)
        self.assertTrue(page.startswith("<!doctype html>"))

    def test_invalid_or_unavailable(self):
        for body in ("", "   ", None, 12):
            with self.assertRaises(ValueError):
                pdf.html_to_pdf(body)
        with mock.patch.object(pdf, "find_browser", return_value=None), self.assertRaises(pdf.PdfUnavailable):
            pdf.html_to_pdf("<p>ok</p>")

    @unittest.skipUnless(pdf.find_browser(), "Chrome or Chromium missing")
    def test_real_pdf(self):
        data = pdf.html_to_pdf("<h1>Answer</h1><p>éàç</p>", "Test")
        self.assertTrue(data.startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main()
