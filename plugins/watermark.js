export default function watermarkPlugin(player) {
  const mark = document.createElement('div');
  mark.className = 'video-watermark';
  mark.textContent = 'DEMO TEST';
  player.container.style.position = 'relative';
  player.container.appendChild(mark);
}
