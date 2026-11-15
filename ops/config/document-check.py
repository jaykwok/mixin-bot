"""Exercise document libraries and the same Office converter used by document-work, using disposable samples."""
import io
import sys
import tempfile
from contextlib import closing
from pathlib import Path


def main():
    from docx import Document
    from openpyxl import Workbook, load_workbook
    from pptx import Presentation
    from pypdf import PdfReader, PdfWriter
    import pypdfium2 as pdfium

    print(f"Python：{sys.version.split()[0]}", flush=True)
    with tempfile.TemporaryDirectory(prefix="check-", dir=sys.argv[1]) as name:
        folder = Path(name)
        doc = Document()
        doc.add_paragraph("文档环境检查 Document check")
        source = folder / "check.docx"
        doc.save(source)
        assert Document(source).paragraphs[0].text.startswith("文档环境检查")
        print("[通过] DOCX 读写", flush=True)
        slides = Presentation()
        slides.slides.add_slide(slides.slide_layouts[6])
        stream = io.BytesIO()
        slides.save(stream)
        stream.seek(0)
        assert len(Presentation(stream).slides) == 1
        print("[通过] PPTX 读写", flush=True)
        book = Workbook()
        book.active["A1"] = "文档环境检查"
        stream = io.BytesIO()
        book.save(stream)
        stream.seek(0)
        loaded = load_workbook(stream)
        assert loaded.active["A1"].value == "文档环境检查"
        loaded.close()
        book.close()
        print("[通过] XLSX 读写", flush=True)
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=300)
        stream = io.BytesIO()
        writer.write(stream)
        stream.seek(0)
        assert len(PdfReader(stream).pages) == 1
        print("[通过] PDF 读写", flush=True)
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src/agent/modules/document-work/scripts"))
        from document_ops import convert_office
        # The conversion tool uses a short, separate system-temp profile too (especially important on Windows).
        with tempfile.TemporaryDirectory(prefix="mixin-office-") as profile:
            pdf = convert_office(source, folder, Path(profile), sys.argv[2] or None)
        with pdfium.PdfDocument(pdf) as document:
            assert len(document) > 0
            with closing(document[0]) as page:
                with closing(page.render(scale=1)) as bitmap:
                    assert bitmap.width > 0 and bitmap.height > 0
        print("[通过] LibreOffice 转换与 PDF 页面渲染", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[失败] {error}", file=sys.stderr, flush=True)
        sys.exit(1)
