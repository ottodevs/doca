// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1

const { ethers } = require("hardhat");

interface Instruction {
  data: string;
}

// Helper class for building SwapVM programs
class ProgramBuilder {
  private instructions: Instruction[];

  constructor() {
    this.instructions = [];
  }

  static init(): ProgramBuilder {
    return new ProgramBuilder();
  }

  addInstruction(opcode: number, args: string | Uint8Array | Buffer | null | undefined = ""): ProgramBuilder {
    // Convert args to hex bytes string
    let argsBytes: string;
    if (typeof args === 'string') {
      // Handle string arguments (remove '0x' prefix if present)
      argsBytes = args.startsWith('0x') ? args.substring(2) : args;
    } else if (args instanceof Uint8Array || Buffer.isBuffer(args)) {
      // Handle Uint8Array or Buffer arguments
      argsBytes = Array.from(args)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } else if (args === null || args === undefined) {
      argsBytes = "";
    } else {
      // Assume it's already a hex string without 0x prefix
      argsBytes = args;
    }

    // Calculate the length of args in bytes (not hex chars)
    const bytesLength = argsBytes.length / 2;
    const lengthHex = bytesLength.toString(16).padStart(2, '0');

    // Store opcode, length, and args as complete instruction data
    this.instructions.push({
      data: opcode.toString(16).padStart(2, '0') + lengthHex + argsBytes
    });
    return this;
  }

  build(): string {
    // Concatenate all instruction bytecode
    let programBytes = "0x";
    for (const instruction of this.instructions) {
      programBytes += instruction.data;
    }
    return programBytes;
  }
}

export { ProgramBuilder };
