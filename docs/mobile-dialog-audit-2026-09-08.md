# Mobile dialog usability

Search previously had no visible dismissal button and sized its content using
independent viewport fractions, allowing the panel to extend below short screens.
Added a labelled 44px Close control, a search hint, a larger clear-input target,
and a viewport-bounded flex layout with independently scrolling results. Keyboard
focus returns to the opener when dismissed.

Confirmation dialogs now constrain their height, scroll long text, wrap long
words and keep their action buttons outside the scrolling body. Actions have a
minimum 44px height and can wrap on narrow screens.

Validation: TypeScript and targeted ESLint passed; optimized Next.js build passed.
Playwright covers 320x568, 667x320 and 390x240 search layouts, initial input focus,
close target size and focus restoration, plus long confirmation text at 320x320.
The existing smart criteria keyboard-selection test also passed. Reduced viewport
height simulates constrained space; this is not an on-device iOS keyboard test.
API and websocket responses were isolated in these tests; no library data changed.

An isolated production preview uses localhost:53011, proxying the existing API
and serving the new web build. The existing localhost:8080 server was not restarted
because it handles active playback. Preview files and logs live in ignored .local.
