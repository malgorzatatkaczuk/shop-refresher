# shop-refresher

Co 5 minut aktualizuje w sklepie **maviie.pl** (Shopify) produkty od LaBalancii:
dostępne rozmiary, ilości i cenę.

## Jak to działa

1. Czyta arkusz Google **„magazyn” → zakładka „Kalkulacja”**. Bierze tylko wiersze, w których
   kolumna **Producent** to „La Balancia”, i z nich:
   - **Model** – nazwa produktu w sklepie (np. „Komplet Venice śliwkowy”),
   - **nazwa producenta** – nazwa dokładnie jak w XML LaBalancii (np. „Komplet VENICE - Śliwka”),
   - **Cena MAX** – cena w sklepie.
2. Pobiera XML LaBalancii: rozmiary, SKU (EAN) i ilości.
3. W Shopify:
   - produktu jeszcze nie ma → tworzy go jako **wersję roboczą** (bez zdjęć – dodajesz je sama
     i dopiero wtedy ustawiasz status „Aktywny”),
   - produkt już jest → ustawia ilości, dodaje nowe rozmiary, rozmiary zniknięte z XML ustawia na 0,
     poprawia cenę, gdy zmieni się w arkuszu.

Produkty rozpoznawane są po **SKU** (kod EAN rozmiaru). Skrypt **niczego nie usuwa** i nie zmienia
zdjęć, opisów, nazwy ani statusu produktu.

**Nowy produkt LaBalancii:** dopisz wiersz w arkuszu (Model, nazwa producenta, Producent = La Balancia,
Cena MAX). Przy następnym uruchomieniu pojawi się w Shopify jako wersja robocza.

## Konfiguracja (jednorazowo)

Repozytorium jest **publiczne** – dlatego wszystkie dane dostępowe trzymamy w
**Settings → Secrets and variables → Actions**, nigdy w plikach.

### 1. Dostęp do arkusza Google (konto usługi)
1. Wejdź na <https://console.cloud.google.com>, utwórz projekt (np. „maviie-sync”).
2. **APIs & Services → Library** → włącz **Google Sheets API**.
3. **IAM & Admin → Service Accounts → Create service account** (np. „shop-refresher”), bez ról.
4. Wejdź w utworzone konto → **Keys → Add key → JSON** – pobierze się plik z kluczem.
5. Skopiuj adres konta (…@…iam.gserviceaccount.com), otwórz arkusz „magazyn” →
   **Udostępnij** → wklej adres → uprawnienie **Przeglądający**.
6. W GitHubie dodaj sekrety:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` – cała zawartość pobranego pliku JSON,
   - `SHEET_ID` – `1655BgdjPCoVvIyEVGwdr6lqpTdK5vbnznQ9yT24pGbg`.
7. Pobrany plik JSON usuń z komputera (albo schowaj w bezpiecznym miejscu).

### 2. Dostęp do Shopify
1. Wejdź na <https://dev.shopify.com> (Dev Dashboard) → **Create app** (np. „shop-refresher”).
2. W wersji aplikacji ustaw uprawnienia (Access scopes):
   `read_products, write_products, read_inventory, write_inventory, read_locations`.
3. Zainstaluj aplikację w sklepie Maviie Boutique.
4. Z ustawień aplikacji skopiuj **Client ID** i **Client secret** i dodaj w GitHubie sekrety:
   `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.
   (Jeśli masz zamiast tego stały token `shpat_…`, dodaj go jako `SHOPIFY_TOKEN`.)
5. W **Variables** (nie Secrets) dodaj `SHOPIFY_STORE` = `uw2t69-j6.myshopify.com`.

### 3. Feed LaBalancii
Dodaj sekret `FEED_URL` – adres feedu XML od LaBalancii (zawiera prywatny klucz, nie wklejaj go nigdzie publicznie).

### 4. Opcjonalnie
Zmienna `STOCK_BUFFER` (Variables), np. `1` – sklep pokazuje o tyle sztuk mniej niż LaBalancia,
żeby nie sprzedać ostatniej sztuki, która właśnie zeszła u nich.

## Uruchamianie
- Automatycznie co 5 minut (GitHub bywa opóźniony o kilka minut).
- Ręcznie: **Actions → Synchronizacja LaBalancia -> Shopify → Run workflow**
  (z zaznaczonym „Tylko próba” – pokaże w logu, co by zmienił, nic nie zmieniając).

## Test lokalny
```bash
DRY_RUN=1 FEED_FILE=../labalancia.xml SHEET_JSON_FILE=arkusz.json node sync.mjs
```
`arkusz.json` to wiersze arkusza jako tablica tablic (pierwszy wiersz = nagłówki).
