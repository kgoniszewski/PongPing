# Rozkrój Blach – nesting detali DXF/DWG

Strona-narzędzie do optymalizacji rozkroju blach (nesting). Wczytujesz detale z plików
DXF/DWG, podajesz ilości i formaty arkuszy, a algorytm rozmieszcza detale tak, by zużyć
jak najmniej blachy. Wynik pobierasz jako DXF gotowy do CAM-u.

Wszystko działa w przeglądarce, bez serwera i bez wysyłania plików gdziekolwiek.

## Uruchomienie

* otwórz `index.html` bezpośrednio z dysku, **albo**
* uruchom dowolny serwer statyczny w katalogu repozytorium, np. `python3 -m http.server`
  i wejdź na `http://localhost:8000`, **albo**
* włącz GitHub Pages dla tego repozytorium.

Przy pierwszym otwarciu strona wczytuje przykładowe detale i pokazowo je rozkłada.

## Jak używać

1. **Detale.** Wybierz pliki, cały folder albo przeciągnij je na stronę (foldery są
   przeszukiwane rekurencyjnie). Każdy zamknięty obrys zewnętrzny to osobny detal;
   kontury w jego środku to otwory, a linie otwarte wewnątrz (np. grawer, linie gięcia)
   jadą razem z detalem. Identyczne detale z jednego pliku są łączone w jedną pozycję.
   Dla każdej pozycji ustaw ilość i, jeśli trzeba, ograniczenie obrotu (np. ze względu
   na kierunek walcowania). Szybko dodasz też prostokąt albo krążek/pierścień.
2. **Arkusze.** Jeden lub więcej formatów (długość X × szerokość Y) z limitem sztuk.
   Kolejność na liście to priorytet użycia. Materiał i grubość służą do policzenia masy.
3. **Parametry.** Odstęp między detalami (szerokość cięcia + mostek), margines od krawędzi,
   krok obrotu, kierunek układania oraz czas optymalizacji.

Wynik pokazuje liczbę arkuszy, wykorzystanie blachy, odpad (m² i kg), resztkę nadającą się
do ponownego użycia i zestawienie detali. Eksport: DXF wszystkich arkuszy lub pojedynczego
arkusza (warstwy `CIECIE`, `GRAWER`, `ARKUSZ`, `OPISY`; łuki i okręgi pozostają łukami)
oraz zestawienie CSV.

## Obsługiwane dane

* **DXF** (ASCII, dowolna wersja): `LINE`, `ARC`, `CIRCLE`, `LWPOLYLINE`/`POLYLINE`
  (z łukami bulge), `ELLIPSE`, `SPLINE` (NURBS), `INSERT` (bloki zagnieżdżone, obrót,
  skala, lustro, tablice), encje z odwróconą normalną (OCS). Teksty, wymiary i kreskowania
  są pomijane. Jednostki z `$INSUNITS` albo ustawione ręcznie w „Opcjach importu”;
  tam też można pominąć wybrane warstwy (np. ramkę rysunku).
* **DWG**: odczyt przez [LibreDWG](https://github.com/mlightcad/libredwg-web) skompilowany
  do WebAssembly, ładowany z CDN jsDelivr przy pierwszym pliku DWG (~11 MB, wymaga internetu).
  Gdy nie ma dostępu do sieci, zapisz rysunki jako DXF.

## Algorytm

* **Obrys roboczy.** Każdy detal jest powiększany o połowę odstępu, a obrysy o wielu
  wierzchołkach (łuki, splajny) upraszczane i ponownie powiększane o tolerancję, więc obrys
  roboczy zawsze obejmuje rzeczywisty kształt.
* **No-Fit Polygon.** Dla par detali (z obrotami) liczony jest NFP jako suma Minkowskiego
  A ⊕ (−B): unia równoległoboków krawędź×krawędź plus wnętrza (biblioteka Clipper).
  W NFP wycinane są obszary, w których mniejszy detal mieści się w całości w otworze
  większego, dzięki czemu małe detale trafiają do otworów.
* **Rozmieszczanie.** Obszar dopuszczalny to prostokąt arkusza minus suma NFP ustawionych
  już detali (aktualizowana przyrostowo). Kandydatami są wierzchołki tego obszaru;
  wybierany jest ten, który najmniej wydłuża zajętą część arkusza, a przy remisie leży
  najniżej i najbardziej w lewo. Dla każdego detalu sprawdzane są wszystkie dozwolone obroty.
* **Optymalizacja.** Algorytm genetyczny (steady-state, krzyżowanie OX, mutacje
  zamian/przesunięć) szuka najlepszej kolejności wkładania detali. Warianty są oceniane
  równolegle w Web Workerach. Funkcja celu: najpierw wszystkie detale rozmieszczone,
  potem jak najmniejsza powierzchnia arkuszy pomniejszona o największą resztkę.

Dokładność: współrzędne są liczone w setnych milimetra; detale zachowują zadany odstęp
z tolerancją 0,02 mm.

## Struktura

| Plik | Rola |
| --- | --- |
| `index.html`, `css/style.css` | interfejs |
| `js/cadparse.js` | parser DXF, adapter LibreDWG (DWG) |
| `js/geometry.js` | rozbijanie bloków, łączenie elementów w kontury, obrysy i otwory |
| `js/nestcore.js` | NFP i rozmieszczanie (wykonywane w Web Workerach) |
| `js/optimizer.js` | algorytm genetyczny, pula wątków |
| `js/dxfwrite.js` | eksport DXF (R12) |
| `js/samples.js` | przykładowe detale |
| `js/vendor/clipper.js` | Clipper 6.4.2 (Angus Johnson, Boost Software License) |

## Testy

```
node test/run-tests.js
```

Testy sprawdzają brak kolizji i zachowanie odstępów (również dla losowych kształtów
wklęsłych z otworami), wkładanie detali w otwory, import DXF (pola powierzchni dla łuków,
bloków, OCS, splajnów, elips) oraz eksport DXF z ponownym importem. Pliki testowe DXF
w `test/fixtures` generuje skrypt `generate_fixtures.py` (wymaga `ezdxf`).

## Licencja

GPL-3.0 (plik `LICENSE`). Clipper: Boost Software License 1.0. LibreDWG: GPL-3.0.
