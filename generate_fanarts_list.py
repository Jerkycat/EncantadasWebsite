import os
import json

fanarts_dir = 'static/imgs/fanarts'
extensions = ('.jpg', '.jpeg', '.png', '.gif', '.webp')

# Lista todos os arquivos de imagem na pasta
files = [f for f in os.listdir(fanarts_dir) 
         if f.lower().endswith(extensions)]

# Ordena alfabeticamente
files.sort()

# Salva o JSON
with open(os.path.join(fanarts_dir, 'list.json'), 'w', encoding='utf-8') as f:
    json.dump(files, f, indent=2, ensure_ascii=False)

print(f"✓ {len(files)} fanarts encontradas e salvas em list.json")
for file in files:
    print(f"  - {file}")