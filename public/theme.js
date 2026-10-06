// Подключается в <head> до стилей, чтобы выбранная тема применилась без мигания
try {
  var theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (e) {}
