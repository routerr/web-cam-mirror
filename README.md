# In-Memory Camera/Mic Recorder (SPA)

零依賴、單頁、全程在瀏覽器內完成：

- 讀取相機 + 麥克風（`getUserMedia`）
- 即時預覽 + CSS 浮動畫中畫
- Picture-in-Picture（瀏覽器原生 PiP）
- 錄製/停止（`MediaRecorder`，資料只在記憶體內）
- 錄製後可用 Canvas + MediaRecorder 產生不同解析度/FPS 的版本（同樣在記憶體內），並下載

## Run

`getUserMedia` 需要安全環境：`https://` 或 `http://localhost`。

在此資料夾啟動本機 server（任選其一）：

```bash
python3 -m http.server 5173
```

然後打開：

```text
http://localhost:5173
```

## Notes

- 若瀏覽器不支援 `MediaRecorder`，可預覽但無法錄製（部分 Safari/iOS 常見）。
- 轉出不同解析度/FPS 的版本是用「播放錄影 -> 以 Canvas 縮放 -> 重新錄一份」的方式；速度取決於裝置效能與影片長度。
- 若要更快、品質更好、更多格式（例如 mp4/h264/av1），下一步可改用 WebCodecs（或 ffmpeg.wasm 當 fallback）。

