ASCILINE – Canvas start/sync fix

Änderungen in diesem Paket:
- Canvas-Sitzungen verwenden in session.py jetzt tatsächlich den H.264-constrained Resolver-Pfad (prefer_native=True).
- watch.html lässt den Lade-Overlay sichtbar, bis der erste echte Videoframe gezeichnet wurde.
- Bei browserseitig blockiertem Audio erscheint eine klare Startaufforderung statt eines schwarzen Bildschirms. Der Klick startet Audio im Nutzer-Gesture und setzt den Video-MP4-Stream neu an, damit beide bei Medienzeit null starten.
- MP4Box extrahiert kleinere Batches (8 statt 120 Samples).
- Decoder-Eingabe wird begrenzt, damit FFmpeg-/Netzwerk-Bursts keine unkontrollierte Decoder-Warteschlange erzeugen.
- Audio-Playbackrate wird nicht mehr anhand eines möglicherweise feststehenden audio.currentTime manipuliert. Video und Audio verwenden denselben monotonen Startzeitpunkt.

Deployment:
1. Dateien aus diesem ZIP in das bestehende Repository übernehmen.
2. Git commit + push und Render-Deployment abwarten.
3. Im Browser die Watch-Seite mit Strg+F5 neu laden.
4. Im Log prüfen: native Canvas stream opened ... format=avc1...

Hinweis: Wenn der Browser automatischen Tonstart blockiert, ist ein expliziter Klick eine Browsersicherheitsvorgabe. Diese Version zeigt dafür einen verständlichen Startbildschirm und synchronisiert Video nach dem Klick neu.
