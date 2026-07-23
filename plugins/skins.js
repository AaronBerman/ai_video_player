let skinStyleInjected = false;

export default function registerSkins(player) {
  if (!skinStyleInjected) {
    const style = document.createElement('style');
    style.textContent = `
      .skin-default {
        background-color: #000;
        border: 2px solid #444;
        border-radius: 8px;
      }

      .skin-light {
        background-color: #f9f9f9;
        border: 2px solid #ccc;
        border-radius: 8px;
      }

      .skin-dark {
        background-color: #000;
        border: 2px solid #222;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
      }

      .skin-modern {
        border: 2px solid #00bcd4;
        border-radius: 12px;
        box-shadow: 0 0 12px rgba(0, 188, 212, 0.3);
      }

      .skin-minimal {
        border: none;
        border-radius: 0;
        box-shadow: none;
        background: transparent;
      }

      .skin-cinema {
        background-color: #000;
        border: 6px solid #000;
        border-radius: 4px;
        box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8), 0 4px 24px rgba(0, 0, 0, 0.7);
      }

      .skin-rounded {
        border: 2px solid #e0e0e0;
        border-radius: 24px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        overflow: hidden;
      }

      .skin-high-contrast {
        border: 4px solid #ffff00;
        border-radius: 4px;
        background-color: #000;
        outline: 2px solid #000;
        outline-offset: 2px;
      }

      .skin-retro {
        border: 4px solid #555;
        border-radius: 16px;
        background-color: #1a1a1a;
        box-shadow:
          inset 0 0 30px rgba(0, 0, 0, 0.5),
          0 4px 0 #333,
          0 6px 12px rgba(0, 0, 0, 0.4);
        background-image:
          repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            rgba(0, 0, 0, 0.03) 2px,
            rgba(0, 0, 0, 0.03) 4px
          );
      }
    `;
    document.head.appendChild(style);
    skinStyleInjected = true;
  }
}
