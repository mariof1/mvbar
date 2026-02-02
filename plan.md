- [x] Unstick scan jobs on worker restart
- [x] Make search tolerate missing Meili index
- [x] Intelligent metadata extraction (BOM, separators, country/genre logic)
- [x] "Appears On" logic and UI
- [x] Wipe and verify clean scan
- [x] Fix "feat" separation (comma splitting reverted by user request)
- [ ] Rebuild/restart and verify scan completes + search works

## Intelligent Scanning & File Watching
- [ ] Research/Design file watcher (inotify/chokidar) for instant updates
- [ ] Handle file rename/move (inode tracking or size+mtime hash)
- [ ] Handle temporary deletion (debounce/grace period)
- [ ] Network loss resilience (retry/pause on EIO)
- [ ] Disable manual/interval scans in favor of watcher-only mode