import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

import java.util.List;
import java.util.Map;
import java.util.Properties;

public class TripProducer {
    public static void main(String[] args) throws Exception {
        String bootstrap =
                System.getenv().getOrDefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092");
        try (var admin = Admin.create(Map.of("bootstrap.servers", bootstrap))) {
            // Один раздел журнала и одна копия для локального опыта
            admin.createTopics(List.of(new NewTopic("lesson-java-trips", 1, (short) 1)))
                    .all()
                    .get();
        }

        var settings = new Properties();
        settings.setProperty(
                "bootstrap.servers",
                System.getenv().getOrDefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092"));
        settings.setProperty("key.serializer", StringSerializer.class.getName());
        settings.setProperty("value.serializer", StringSerializer.class.getName());

        try (var producer = new KafkaProducer<String, String>(settings)) {
            for (String event : List.of("e1", "e2")) {
                // get ожидает завершения отправки до перехода к чтению
                producer.send(new ProducerRecord<>("lesson-java-trips", event)).get();
            }
        }
    }
}
