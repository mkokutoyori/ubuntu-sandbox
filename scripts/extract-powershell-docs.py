"""Extrait le texte des PDF de official_docs/microsoft/powershell dans /tmp/psdocs.

Usage : python3 scripts/extract-powershell-docs.py 1   (puis 2 .. 5)

La partie 3 porte la specification du langage (chapitres 2 a 13 : lexique,
types, conversions au chapitre 6, operateurs au chapitre 7, instructions au 8,
tableaux au 9, tables de hachage au 10). Les autres parties portent les
articles about_*.
"""
import os
import sys
from pypdf import PdfReader

n = sys.argv[1]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'official_docs', 'microsoft', 'powershell')
os.makedirs('/tmp/psdocs', exist_ok=True)
reader = PdfReader(os.path.join(root, f'powershell-7.6-documentation-part00{n}.pdf'))
with open(f'/tmp/psdocs/part{n}.txt', 'w') as out:
    for i, page in enumerate(reader.pages):
        out.write(f'\n\n=====PAGE {i + 1}=====\n')
        out.write(page.extract_text() or '')
