/*global UIkit, Vue */
(() => {
  const notification = (config) =>
    UIkit.notification({
      pos: "top-right",
      timeout: 5000,
      ...config,
    });

  const alert = (message) =>
    notification({
      message,
      status: "danger",
    });

  const info = (message) =>
    notification({
      message,
      status: "success",
    });

  let ws = null;

  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${wsProto}//${location.host}`);

    ws.onopen = () => {
      if (window.AUTH_TOKEN) {
        ws.send(JSON.stringify({ type: "authenticate", token: window.AUTH_TOKEN }));
      }
    };

    ws.onerror = (error) => {
      alert("Ошибка WebSocket. Попробуйте перезагрузить страницу.");
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      alert("Соединение с сервером разорвано. Перезагрузите страницу.");
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "active_timers") {
        app.activeTimers = message.data;
      } else if (message.type === "all_timers") {
        app.activeTimers = message.data.filter((t) => t.isActive);
        app.oldTimers = message.data.filter((t) => !t.isActive);
      }
    };
  }

  connectWebSocket();

  const app = new Vue({
    el: "#app",
    data: {
      desc: "",
      activeTimers: [],
      oldTimers: [],
    },
    methods: {
      createTimer() {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          alert("WebSocket не подключен.");
          return;
        }
        const description = this.desc.trim();
        if (!description) return;

        this.desc = "";
        ws.send(
          JSON.stringify({
            type: "create_timer",
            description,
          })
        );
        info("Таймер успешно создан!");
      },

      stopTimer(id) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          alert("WebSocket не подключен.");
          return;
        }
        ws.send(
          JSON.stringify({
            type: "stop_timer",
            timerId: id,
          })
        );
        info("Таймер успешно остановлен!");
      },

      formatTime(ts) {
        return new Date(Number(ts)).toTimeString().split(" ")[0];
      },

      formatDuration(d) {
        d = Math.floor(d / 1000);
        const s = d % 60;
        d = Math.floor(d / 60);
        const m = d % 60;
        const h = Math.floor(d / 60);
        return [h > 0 ? h : null, m, s]
          .filter((x) => x !== null)
          .map((x) => (x < 10 ? "0" : "") + x)
          .join(":");
      },
    },
  });
})();
