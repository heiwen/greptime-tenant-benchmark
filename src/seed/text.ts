const VOCABULARY = [
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it',
  'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this',
  'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or',
  'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know',
  'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could',
  'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come',
  'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how',
  'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because',
  'any', 'these', 'give', 'day', 'most', 'us', 'between', 'need', 'large',
  'often', 'hand', 'high', 'place', 'hold', 'turn', 'help', 'world',
  'through', 'example', 'always', 'music', 'those', 'both', 'mark', 'book',
  'letter', 'until', 'mile', 'river', 'car', 'feet', 'care', 'second',
  'enough', 'plain', 'girl', 'usual', 'young', 'ready', 'above', 'ever',
  'red', 'list', 'though', 'feel', 'talk', 'bird', 'soon', 'body',
  'dog', 'family', 'direct', 'pose', 'leave', 'song', 'measure', 'door',
  'product', 'black', 'short', 'numeral', 'class', 'wind', 'question',
  'happen', 'complete', 'ship', 'area', 'half', 'rock', 'order', 'fire',
  'south', 'problem', 'piece', 'told', 'knew', 'pass', 'since', 'top',
  'whole', 'king', 'space', 'heard', 'best', 'hour', 'better', 'true',
  'during', 'hundred', 'five', 'remember', 'step', 'early', 'hold', 'west',
  'ground', 'interest', 'reach', 'fast', 'verb', 'sing', 'listen', 'six',
  'table', 'travel', 'less', 'morning', 'ten', 'simple', 'several', 'vowel',
  'toward', 'war', 'lay', 'against', 'pattern', 'slow', 'center', 'love',
  'person', 'money', 'serve', 'appear', 'road', 'map', 'rain', 'rule',
  'govern', 'pull', 'cold', 'notice', 'voice', 'power', 'town', 'fine',
  'drive', 'print', 'set', 'fall', 'surprise', 'industry', 'plain',
  'system', 'behind', 'ran', 'round', 'boat', 'game', 'force', 'bring',
];

const PUNCTUATION = ['.', '.', '.', ',', ',', '!', '?', ';'];

function randomWord(): string {
  return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)];
}

export function randomText(targetBytes: number): string {
  const words: string[] = [];
  let currentBytes = 0;
  let wordsSincePunct = 0;

  while (currentBytes < targetBytes) {
    const word = randomWord();
    words.push(word);
    currentBytes += word.length + 1; // +1 for space
    wordsSincePunct++;

    // Add punctuation every 8-15 words
    if (wordsSincePunct >= 8 + Math.floor(Math.random() * 8)) {
      const punct = PUNCTUATION[Math.floor(Math.random() * PUNCTUATION.length)];
      words[words.length - 1] += punct;
      wordsSincePunct = 0;

      // Capitalize next word
      if (currentBytes < targetBytes) {
        const nextWord = randomWord();
        words.push(nextWord.charAt(0).toUpperCase() + nextWord.slice(1));
        currentBytes += nextWord.length + 1;
        wordsSincePunct++;
      }
    }
  }

  return words.join(' ').slice(0, targetBytes);
}

export function randomJson(targetBytes: number): string {
  const obj: Record<string, unknown> = {};
  let currentSize = 2; // {}

  const keys = [
    'id', 'name', 'value', 'type', 'status', 'message', 'code', 'data',
    'timestamp', 'version', 'source', 'target', 'level', 'category',
    'description', 'metadata', 'config', 'result', 'error', 'info',
    'count', 'total', 'index', 'flags', 'tags', 'labels', 'attrs',
    'params', 'options', 'settings', 'context', 'payload', 'body',
  ];

  let keyIndex = 0;

  while (currentSize < targetBytes - 20) {
    const key = keyIndex < keys.length
      ? keys[keyIndex]
      : `field_${keyIndex}`;
    keyIndex++;

    const remaining = targetBytes - currentSize;
    let value: unknown;
    let valueStr: string;

    if (remaining > 100 && Math.random() < 0.3) {
      // Nested object
      const nested: Record<string, unknown> = {
        value: randomWord(),
        count: Math.floor(Math.random() * 1000),
        enabled: Math.random() > 0.5,
        label: randomWord() + ' ' + randomWord(),
      };
      valueStr = JSON.stringify(nested);
      value = nested;
    } else if (remaining > 50 && Math.random() < 0.4) {
      // String value
      const strLen = Math.min(remaining - 20, 20 + Math.floor(Math.random() * 60));
      const str = randomText(strLen);
      valueStr = JSON.stringify(str);
      value = str;
    } else if (Math.random() < 0.5) {
      // Number
      value = Math.floor(Math.random() * 100000);
      valueStr = String(value);
    } else {
      // Boolean
      value = Math.random() > 0.5;
      valueStr = String(value);
    }

    obj[key] = value;
    // key + value + quotes + colon + comma + space
    currentSize += key.length + 2 + valueStr.length + 3;
  }

  return JSON.stringify(obj);
}
