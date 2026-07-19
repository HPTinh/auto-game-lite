export const processAccountLogic = async (acc: any, updateAccount: (id: string, updates: any) => void, runtimeState: any) => {
  // Giai đoạn 1 chỉ kiểm tra/lấy thông tin tài khoản.
  // Không chạy mock farm/craft/daily sau khi account READY.
  if (acc.state === "IDLE" || acc.state === "READY" || acc.state === "ERROR" || acc.state === "PAUSED") return;

  const features = acc.features || {};
  let newAccState = acc.state;
  let featuresUpdated = false;
  const newFeatures = JSON.parse(JSON.stringify(features));
  
  const updates: any = {};
  const addLog = (msg: string) => {
    if (!updates.logs) updates.logs = [...(acc.logs || [])];
    updates.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (updates.logs.length > 50) updates.logs.pop();
  };

  // Helper function to update feature status
  const setFeatureStatus = (featureId: string, status: string) => {
    if (newFeatures[featureId] && newFeatures[featureId].status !== status) {
      newFeatures[featureId].status = status;
      featuresUpdated = true;
    }
  };

  // 1. Logic Tự động bơm HP/MP
  if (features.auto_potion?.enabled) {
    setFeatureStatus("auto_potion", "IN_PROGRESS");
    const hpThreshold = parseInt(features.auto_potion.settings?.hp_percent || "20");
    const mpThreshold = parseInt(features.auto_potion.settings?.mp_percent || "20");
    const potionType = features.auto_potion.settings?.potion_type || "auto";

    // MOCK: Kiểm tra HP (giả lập)
    const currentHp = Math.floor(Math.random() * 100); 
    const currentMp = Math.floor(Math.random() * 100);

    if (currentHp < hpThreshold || currentMp < mpThreshold) {
      addLog(`Bơm HP/MP (HP: ${currentHp}%, MP: ${currentMp}%) - Loại bình: ${potionType}`);
      // TODO: Fetch API bơm máu ở đây: 
      // await fetch(`${BASE_URL}/rest/v1/rpc/use_item`, { ... })
    }
  }

  // 2. Logic Tự động Buff
  if (features.buff?.enabled) {
    setFeatureStatus("buff", "IN_PROGRESS");
    const now = Date.now();
    const lastBuff = runtimeState.current[acc.id]?.lastBuff || 0;
    // Giả lập buff mỗi 60s
    if (now - lastBuff > 60000) {
      addLog(`Sử dụng kỹ năng Buff tự động.`);
      runtimeState.current[acc.id] = { ...runtimeState.current[acc.id], lastBuff: now };
      // TODO: Fetch API dùng skill buff
    }
  }

  // 3. Logic Farm Quái Đa Kênh & Thông Minh
  if (features.farm?.enabled) {
    setFeatureStatus("farm", "IN_PROGRESS");
    newAccState = "ONLINE_MANUAL_FARM";
    const farmMode = features.farm.settings?.mode || "all";
    const multiChannel = features.farm.settings?.multi_channel || false;
    const fromChannel = parseInt(features.farm.settings?.from_channel || "1");
    const toChannel = parseInt(features.farm.settings?.to_channel || "5");
    
    // Lấy state runtime của account
    let state = runtimeState.current[acc.id] || {};
    let currentChannel = state.currentChannel || fromChannel;
    
    // Nếu kênh hiện tại ngoài vùng quét, reset lại
    if (currentChannel < fromChannel || currentChannel > toChannel) {
      currentChannel = fromChannel;
    }

    // MOCK: Fake kết quả quét quái
    const hasMonsters = Math.random() > 0.3; // 70% có quái
    const hasBoss = Math.random() > 0.8;     // 20% có boss
    const hasElite = Math.random() > 0.6;    // 40% có elite
    
    let targetType = "normal";

    if (!hasMonsters) {
      // Nếu không có quái, chuyển kênh nếu bật đa kênh
      if (multiChannel) {
        currentChannel++;
        if (currentChannel > toChannel) currentChannel = fromChannel;
        addLog(`Kênh rỗng. Chuyển sang Kênh ${currentChannel}`);
      } else {
        addLog(`Kênh ${currentChannel} không có quái. Chờ respawn...`);
      }
    } else {
      // Xác định mục tiêu đánh dựa trên chế độ
      if (farmMode === "boss" || farmMode === "smart") {
        if (hasBoss) targetType = "boss";
        else if (farmMode === "boss" && multiChannel) {
          // Chỉ đánh boss mà không có -> chuyển kênh
          currentChannel++;
          if (currentChannel > toChannel) currentChannel = fromChannel;
          addLog(`Kênh không có Boss. Chuyển Kênh ${currentChannel}`);
          targetType = "none";
        } else if (farmMode === "smart") {
          // Smart mode: ko có boss thì đánh elite
          targetType = hasElite ? "elite" : "normal";
        }
      } else if (farmMode === "elite") {
        if (hasElite) targetType = "elite";
        else targetType = "normal";
      }

      if (targetType !== "none") {
        addLog(`Tiêu diệt [${targetType.toUpperCase()}] tại Kênh ${currentChannel}`);
        // TODO: Fetch API đánh quái tại đây
        // await fetch(`${BASE_URL}/rest/v1/rpc/attack_monster`, { body: { target: targetType, channel: currentChannel }})
        
        // Cập nhật exp/vàng fake
        updates.gold = (updates.gold || acc.gold) + Math.floor(Math.random() * 50) + 10;
        updates.spiritStones = (updates.spiritStones || acc.spiritStones) + Math.floor(Math.random() * 2);
      }
    }

    // Lưu lại channel
    runtimeState.current[acc.id] = { ...state, currentChannel };
  } else if (features.craft?.enabled) {
    setFeatureStatus("craft", "IN_PROGRESS");
    newAccState = "CRAFT_ONLY";
  }

  // Lưu lại các cập nhật state/features nếu có thay đổi
  if (featuresUpdated) updates.features = newFeatures;
  if (newAccState !== acc.state) updates.state = newAccState;
  
  if (Object.keys(updates).length > 0) {
    updateAccount(acc.id, updates);
  }
};

