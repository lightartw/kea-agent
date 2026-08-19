/**
 * 一个简单的示例程序：打印问候语并计算斐波那契数列。
 */

function fibonacci(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

function greet(name: string = "World"): string {
  return `Hello, ${name}!`;
}

const count = 10;
const sequence = Array.from({ length: count }, (_, i) => fibonacci(i));

console.log(greet("kea_agent"));
console.log(`Fibonacci 前 ${count} 项: ${sequence.join(", ")}`);
