var LIBSYSTEM_KERNEL_PATH = '/usr/lib/system/libsystem_kernel.dylib';
var CORESYMBOLICATION_PATH = '/System/Library/PrivateFrameworks/CoreSymbolication.framework/CoreSymbolication';
var CRASH_REPORTER_SUPPORT_PATH = '/System/Library/PrivateFrameworks/CrashReporterSupport.framework/CrashReporterSupport';
var TASK_DYLD_INFO = 17;
var YES = ptr(1);

var CSTypeRef = ['pointer', 'pointer'];
var kCSNow = uint64('0x8000000000000000');

var nativeOptions = {
  scheduling: 'exclusive',
  exceptions: 'propagate'
};
var _pidForTask = new NativeFunction(
    Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'pid_for_task'),
    'int',
    ['uint', 'pointer'],
    nativeOptions
);
var unlink = new NativeFunction(
    Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'unlink'),
    'int',
    ['pointer'],
    nativeOptions
);
var CSSymbolicatorGetSymbolWithAddressAtTime = new NativeFunction(
    Module.getExportByName(CORESYMBOLICATION_PATH, 'CSSymbolicatorGetSymbolWithAddressAtTime'),
    CSTypeRef,
    [CSTypeRef, 'uint64', 'uint64'],
    nativeOptions
);
var CSIsNull = new NativeFunction(
    Module.getExportByName(CORESYMBOLICATION_PATH, 'CSIsNull'),
    'int',
    [CSTypeRef],
    nativeOptions
);
var mappedMemoryRead = new NativeFunction(
    Module.getExportByName(CORESYMBOLICATION_PATH, 'mapped_memory_read'),
    'uint',
    ['pointer', 'uint64', 'uint64', 'pointer'],
    nativeOptions
);
var mappedMemoryReadPointer = new NativeFunction(
    Module.getExportByName(CORESYMBOLICATION_PATH, 'mapped_memory_read_pointer'),
    'uint',
    ['pointer', 'uint64', 'pointer'],
    nativeOptions
);

var AppleErrorReport = ObjC.classes.AppleErrorReport;
var CrashReport = ObjC.classes.CrashReport;
var NSMutableDictionary = ObjC.classes.NSMutableDictionary;

var crashedPid;
var is64Bit;
var forcedByUs;
var logPath;
var logFd;
var logChunks;
var mappedAgents;
var allImageInfoAddr;
var imageArrayAddress;
var imageElementSize;
var imageTrailerSize;
var imageTrailerPaths;

function reset() {
  crashedPid = -1;
  is64Bit = null;
  forcedByUs = false;
  logPath = null;
  logFd = null;
  logChunks = [];
  mappedAgents = [];
  allImageInfoAddr = null;
  imageArrayAddress = null;
  imageElementSize = null;
  imageTrailerSize = null;
  imageTrailerPaths = {};
}

reset();

Interceptor.attach(CrashReport['- initWithTask:exceptionType:thread:threadStateFlavor:threadState:threadStateCount:'].implementation, {
  onEnter: function (args) {
    var task = args[2].toUInt32();

    crashedPid = pidForTask(task);
    send(['crash-detected', crashedPid]);

    var op = recv('mapped-agents', function (message) {
      mappedAgents = message.payload.map(function (agent) {
        return {
          machHeaderAddress: uint64(agent.machHeaderAddress),
          uuid: agent.uuid,
          path: agent.path,
        };
      });
    });
    op.wait();
  },
});

Interceptor.attach(Module.getExportByName(CORESYMBOLICATION_PATH, 'task_is_64bit'), {
  onEnter: function (args) {
    this.pid = pidForTask(args[0].toUInt32());
  },
  onLeave: function (retval) {
    if (this.pid === crashedPid)
      is64Bit = !!retval.toUInt32();
  }
});

Interceptor.attach(CrashReport['- isActionable'].implementation, {
  onLeave: function (retval) {
    var isActionable = !!retval.toInt32();
    if (!isActionable) {
      retval.replace(ptr(1));
      forcedByUs = true;
    }
  },
});

Interceptor.attach(NSMutableDictionary['- logCounter_isLog:byKey:count:withinLimit:withOptions:'].implementation, {
  onLeave: function (retval) {
    var isLogWithinLimit = !!retval.toInt32();
    if (!isLogWithinLimit) {
      retval.replace(ptr(1));
      forcedByUs = true;
    }
  },
});

Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'rename'), {
  onEnter: function (args) {
    var newPath = args[1].readUtf8String();
    if (/\.ips$/.test(newPath)) {
      logPath = newPath;
    }
  },
});

Interceptor.attach(AppleErrorReport['- saveToDir:'].implementation, {
  onLeave: function (retval) {
    if (forcedByUs) {
      unlink(Memory.allocUtf8String(logPath));
      reset();
    }
  },
});

Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'open_dprotected_np'), {
  onEnter: function (args) {
    var path = args[0].readUtf8String();
    this.isCrashLog = /\.ips$/.test(path);
  },
  onLeave: function (retval) {
    if (this.isCrashLog)
      logFd = retval.toInt32();
  },
});

Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'close'), {
  onEnter: function (args) {
    var fd = args[0].toInt32();
    if (fd !== logFd)
      return;

    if (crashedPid !== -1) {
      send(['crash-received', crashedPid, logChunks.join('')]);
      crashedPid = -1;
    }
    logFd = null;
    logChunks = [];
  },
});

Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'write'), {
  onEnter: function (args) {
    var fd = args[0].toInt32();
    this.isCrashLog = (fd === logFd);
    this.buf = args[1];
  },
  onLeave: function (retval) {
    if (!this.isCrashLog)
      return;

    var n = retval.toInt32();
    if (n === -1)
      return;
    var chunk = this.buf.readUtf8String(n);
    logChunks.push(chunk);
  }
});

Interceptor.attach(Module.getExportByName(CRASH_REPORTER_SUPPORT_PATH, 'OSAPreferencesGetBoolValue'), {
  onEnter: function (args) {
    this.name = new ObjC.Object(args[0]).toString();
    this.domain = new ObjC.Object(args[1]).toString();
    this.successPtr = args[2];
  },
  onLeave: function (retval) {
    if (this.name === 'SymbolicateCrashes' && this.domain === 'com.apple.CrashReporter') {
      if (!this.successPtr.isNull())
        this.successPtr.writeU8(1);
      retval.replace(ptr(1));
    }
  }
});

Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, 'task_info'), {
  onEnter: function (args) {
    this.pid = pidForTask(args[0].toUInt32());
    this.flavor = args[1].toUInt32();
    this.info = args[2];
    this.count = args[3];
  },
  onLeave: function (retval) {
    if (this.pid !== crashedPid || this.flavor !== TASK_DYLD_INFO || retval.toUInt32() !== 0)
      return;

    var info = this.info;
    switch (this.count.readUInt()) {
      case 1:
      case 3:
        allImageInfoAddr = uint64(info.readU32());
        break;
      case 5:
        allImageInfoAddr = info.readU64();
        break;
      default:
        throw new Error('Unexpected TASK_DYLD_INFO count');
    }
  }
});

[
  ['mach_vm_read', false, 32],
  ['mach_vm_read_overwrite', true, 64],
].forEach(function (entry) {
  var name = entry[0];
  var inplace = entry[1];
  var sizeWidth = entry[2];

  var readSize = (sizeWidth !== 32) ? Memory['readU' + sizeWidth].bind(Memory) : readSizeFromU32;
  var writeSize = Memory['writeU' + sizeWidth].bind(Memory);

  Interceptor.attach(Module.getExportByName(LIBSYSTEM_KERNEL_PATH, name), {
    onEnter: function (args) {
      var pid = pidForTask(args[0].toUInt32());
      if (pid !== crashedPid)
        return;
      this.instrumented = true;

      var address = uint64(args[1].toString());
      this.address = address;
      var size = uint64(args[2].toString());
      this.size = size;
      this.data = args[3];
      this.dataSize = args[4];

      if (imageArrayAddress !== null && address.equals(imageArrayAddress)) {
        args[2] = ptr(size.sub(imageTrailerSize));
      }
    },
    onLeave: function (retval) {
      if (!this.instrumented || retval.toUInt32() !== 0)
        return;

      var startAddress = this.address;

      if (allImageInfoAddr !== null && startAddress.equals(allImageInfoAddr)) {
        var allImageInfos = getData(this);

        imageArrayAddress = readRemotePointer(allImageInfos.add(8));

        var extraImageCount = mappedAgents.length;

        var imageArrayCountPtr = allImageInfos.add(4);
        var imageArrayCount = imageArrayCountPtr.readU32();
        imageArrayCountPtr.writeU32(imageArrayCount + extraImageCount);

        imageElementSize = 3 * (is64Bit ? 8 : 4);
        imageTrailerSize = extraImageCount * imageElementSize;
      } else if (imageArrayAddress !== null && startAddress.equals(imageArrayAddress)) {
        var imageTrailerStart = getData(this).add(this.size).sub(imageTrailerSize);
        mappedAgents.forEach(function (agent, index) {
          var element = imageTrailerStart.add(index * imageElementSize);

          var loadAddress = agent.machHeaderAddress;
          var filePath = loadAddress.sub(4096);
          var modDate = 0;

          if (is64Bit) {
            element
                .writeU64(loadAddress).add(8)
                .writeU64(filePath).add(8)
                .writeU64(modDate);
          } else {
            element
                .writeU32(loadAddress).add(4)
                .writeU32(filePath).add(4)
                .writeU32(modDate);
          }

          imageTrailerPaths[filePath.toString()] = agent;
        });

        var dataSize = readSize(this.dataSize);
        writeSize(this.dataSize, dataSize.add(imageTrailerSize));
      } else {
        var agent = imageTrailerPaths[startAddress.toString()];
        if (agent !== undefined)
          getData(this).writeUtf8String(agent.path);
      }
    }
  });

  function getData(invocationContext) {
    return inplace ? invocationContext.data : invocationContext.data.readPointer();
  }
});

function pidForTask(task) {
  var pidBuf = Memory.alloc(4);
  _pidForTask(task, pidBuf);
  return pidBuf.readU32();
}

function readRemotePointer(address) {
  return is64Bit ? address.readU64() : uint64(address.readU32());
}

function readSizeFromU32(address) {
  return uint64(address.readU32());
}

if (Process.arch === 'arm64') {
  Interceptor.attach(ObjC.classes.VMUSampler['- sampleAllThreadsOnceWithFramePointers:'].implementation, {
    onEnter: function (args) {
      args[2] = YES;
    }
  });

  Interceptor.attach(ObjC.classes.VMUBacktrace['- fixupStackWithSamplingContext:symbolicator:'].implementation, {
    onEnter: function (args) {
      this.self = new ObjC.Object(args[0]);
      this.samplingContext = args[2];
      this.symbolicator = [args[3], args[4]];
    },
    onLeave: function () {
      if (!is64Bit)
        return;

      var callstack = this.self.$ivars._callstack;
      var samplingContext = this.samplingContext;
      var mappedMemory = new MappedMemory(samplingContext.add(8).readPointer());
      var symbolicator = this.symbolicator;

      var frames = callstack[1];
      var framePtrs = callstack[2];
      var length = callstack[3];

      for (var i = 0; i !== length; i++) {
        var frameSlot = frames.add(i * 8);
        var frame = frameSlot.readU64();

        var symbol = CSSymbolicatorGetSymbolWithAddressAtTime(symbolicator, frame, kCSNow);
        if (!CSIsNull(symbol))
          continue;

        var framePtrAbove = (i > 0) ? framePtrs.add((i - 1) * 8).readU64() : null;

        var functionAddress = tryParseInterceptorTrampoline(frame, framePtrAbove, mappedMemory);
        if (functionAddress !== null)
          frameSlot.writeU64(functionAddress);
      }
    },
  });
}

function MappedMemory(handle) {
  this.handle = handle;
}

var pointerBuf = Memory.alloc(8);

MappedMemory.prototype.read = function (address, size) {
  var kr = mappedMemoryRead(this.handle, address, size, pointerBuf);
  if (kr !== 0)
    throw new Error('Invalid address: 0x' + address.toString(16));
  return pointerBuf.readPointer().readByteArray(size);
};

MappedMemory.prototype.readPointer = function (address) {
  var kr = mappedMemoryReadPointer(this.handle, address, pointerBuf);
  if (kr !== 0)
    throw new Error('Invalid address: 0x' + address.toString(16));
  return pointerBuf.readU64();
};

function tryParseInterceptorTrampoline(code, stackFrameAbove, mappedMemory) {
  var instructions;
  try {
    instructions = new Uint32Array(mappedMemory.read(code, 16));
  } catch (e) {
    return null;
  }

  var result = tryParseInterceptorOnLeaveTrampoline(instructions, code, mappedMemory);
  if (result !== null)
    return result;

  return tryParseInterceptorCallbackTrampoline(instructions, code, stackFrameAbove, mappedMemory);
}

function tryParseInterceptorOnLeaveTrampoline(instructions, code, mappedMemory) {
  var ldr;

  ldr = tryParseLdrRegAddress(instructions[0], code);
  if (ldr === null)
    return null;
  if (ldr[0] !== 'x17')
    return null;
  var functionContextDPtr = ldr[1];

  ldr = tryParseLdrRegAddress(instructions[1], code.add(4));
  if (ldr === null)
    return null;
  if (ldr[0] !== 'x16')
    return null;

  var isBrX16 = instructions[2] === 0xd61f0200;
  if (!isBrX16)
    return null;

  return tryReadInterceptorFunctionContextDoublePointer(functionContextDPtr, mappedMemory);
}

var interceptorCallbackTrampolineSignature = [
  0x910043ff, // add sp, sp, 0x10
  0xa8c103e1, // ldp x1, x0, [sp], 0x10
  0xa8c10be1, // ldp x1, x2, [sp], 0x10
  0xa8c113e3, // ldp x3, x4, [sp], 0x10
];

function tryParseInterceptorCallbackTrampoline(instructions, code, stackFrameAbove, mappedMemory) {
  if (stackFrameAbove === null)
    return null;

  var matches = interceptorCallbackTrampolineSignature.every(function (insn, index) {
    return instructions[index] === insn;
  });
  if (!matches)
    return null;

  var cpuContextStart = stackFrameAbove.add(16 + 8);
  var x17Start = cpuContextStart.add(19 * 8);
  return tryReadInterceptorFunctionContextDoublePointer(x17Start, mappedMemory);
}

function tryReadInterceptorFunctionContextDoublePointer(functionContextDPtr, mappedMemory) {
  try {
    var functionContext = mappedMemory.readPointer(functionContextDPtr);
    var functionAddress = mappedMemory.readPointer(functionContext);
    return functionAddress;
  } catch (e) {
    return null;
  }
}

function tryParseLdrRegAddress(instruction, pc) {
  if ((instruction & 0xff000000) !== 0x58000000)
    return null;

  var reg = instruction & 0x1f;

  var distance = (instruction >>> 5) & 0x7ffff;
  var imm = pc.add(distance * 4);

  return ['x' + reg, imm];
}
