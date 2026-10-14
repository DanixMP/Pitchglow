# Third-party notices

## LAME MP3 encoder (lamejs)

MP3 export uses [LAME](https://lame.sourceforge.io/) through its JavaScript port
[`@breezystack/lamejs`](https://www.npmjs.com/package/@breezystack/lamejs) (a maintained fork of
[lamejs](https://github.com/zhuker/lamejs)), licensed under the **GNU Lesser General Public License v3.0**.

- It is used **unmodified**, and only inside the MP3 export worker (`src/audio/mp3-worker.ts`),
  which the build emits as its own separate file. It is loaded only when you export an MP3.
- Its license text ships in `node_modules/@breezystack/lamejs/LICENSE`. Its source is available from
  the links above.
- To swap in your own build of the library, replace that worker file (or rebuild with a different
  version of the package).
