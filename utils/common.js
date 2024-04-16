function strLen(str = '') {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0 && str.charCodeAt(i) < 128) {
        len += 1;
      } else {
        len += 2;
      }
    }
  
    return len;
  }
  
  function measureText(text, font) {
    let fontSize = 12;
    if (font) {
      fontSize = parseInt(font.split(' ')[3], 10);
    }
    fontSize /= 2;
    return {
      width: strLen(text) * fontSize,
    };
  }
  
  export { measureText };
  